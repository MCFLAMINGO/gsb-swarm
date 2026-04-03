#!/usr/bin/env python3
"""
generate_forms.py — Personal Financial Form Auto-Population
MCFL Restaurant Holdings LLC

Given a structured personal financial data dict, fills:
  1. SBA Form 413 (Personal Financial Statement) — AcroForm PDF
  2. Truist Personal Financial Statement — generated PDF replica

The caller (analyze.py) collects this data from the bank statement
analysis + a supplemental questionnaire stored in the context JSON.

Usage:
    from generate_forms import generate_sba_413, generate_truist_pfs
    sba_path = generate_sba_413(financial_data, output_path, font_name)
    truist_path = generate_truist_pfs(financial_data, output_path, font_name)
"""

import io
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

# ---------------------------------------------------------------------------
# SBA FORM 413 FIELD MAP
# Maps our internal schema keys → SBA AcroForm field names
# ---------------------------------------------------------------------------
SBA_FIELD_MAP = {
    # Identity / Header
    "full_name": "Name",
    "business_phone": "Business Phone xxx-xxx-xxxx",
    "home_address": "Home Address",
    "home_phone": "Home Phone xxx-xxx-xxxx",
    "city_state_zip": "City, State, & Zip Code",
    "business_name": "Business Name of Applicant/Borrower",
    "business_address": "Business Address (if different than home address)",
    "statement_date": "This information is current as of month/day/year",

    # Assets
    "cash_on_hand": "Cash on Hand & in banks",
    "savings_accounts": "Savings Accounts",
    "ira_retirement": "IRA or Other Retirement Account",
    "accounts_receivable": "Accounts and Notes Receivable",
    "life_insurance_csv": "Life Insurance - Cash Surrender Value Only",
    "stocks_bonds": "Stocks and Bonds",
    "real_estate_value": "Real Estate",
    "automobiles": "Automobiles",
    "other_personal_property": "Other Personal Property",
    "other_assets": "Other Assets",
    "total_assets": "TotalAssets",

    # Liabilities
    "accounts_payable": "Accounts Payable",
    "notes_payable": "Notes Payable to Banks and Others",
    "installment_auto": "Installment Account (Auto)",
    "installment_auto_payment": "Installment Account - Monthly Payments (Auto)",
    "installment_other": "Installment Account (Other)",
    "installment_other_payment": "Installment Account - Monthly Payments (Other)",
    "life_insurance_loans": "Loan(s) Against Life Insurance",
    "mortgages": "Mortgages on Real Estate",
    "unpaid_taxes": "Unpaid Taxes",
    "other_liabilities": "Other Liabilities",
    "total_liabilities": "TotalLiabilities",
    "net_worth": "Net Worth",

    # Income
    "salary": "Salary",
    "net_investment_income": "Net Investment Income",
    "real_estate_income": "Real Estate Income",
    "other_income": "Other Income",
    "other_income_description": "Description of Other Income in Section 1: Alimony or child support payments should not be disclosed in Other Income unless it is desired to have such payments counted toward total incomeRow1",

    # Contingent Liabilities
    "as_endorser": "As Endorser or Co-Maker",
    "legal_claims": "Legal Claims and Judgements",
    "federal_tax_provision": "Provision for Federal Income Tax",
    "other_special_debt": "Other Special Debt",

    # Section 5 - Other Personal Property / Assets description
    "section5_description": "Section 5  Other Personal Property and Other Assets: Describe and if any is pledged as security state name and address of lien holder amount of lien terms of payment and if delinquent describe delinquencyRow1",

    # Section 6 - Unpaid Taxes
    "section6_unpaid_taxes": "Section 6 Unpaid Taxes Describe in detail as to type to whom payable when due amount and to what property if any a tax lien attachesRow1",

    # Section 7 - Other Liabilities
    "section7_other_liabilities": "Section 7 Other Liabilities Describe in detailRow1",

    # Section 8 - Life Insurance
    "section8_life_insurance": "Section 8 Life Insurance Held Give face amount and cash surrender value of policies  name of insurance company and BeneficiariesRow1",

    # Signatures
    "signer1_name": "Print Name",
    "signer1_ssn": "Social Security No",
    "signer1_date": "Date",
    "signer2_name": "Print Name_2",
    "signer2_ssn": "Social Security No_2",
    "signer2_date": "Date2",
}

# Checkbox fields — set to '/Yes' to check, '' to uncheck
SBA_CHECKBOX_MAP = {
    "loan_type_7a": "7(a) loan/04 loan/Surety Bonds",
    "loan_type_disaster": "Disaster Business Loan Appliction (Excluding Sole Proprietorships)",
    "loan_type_wosb": "Women Owned Small Business (WOSB) Federal Contracting Program",
    "loan_type_8a": "8(a) Business Development Program",
    "business_type_corporation": "Business Type: Corporation",
    "business_type_scorp": "Business Type: S-Corp",
    "business_type_llc": "Business Type: LLC",
    "business_type_partnership": "Business Type: Partnership",
    "business_type_sole_proprietor": "Business Type: Sole Proprietor",
    "wosb_married_yes": "WOSB Applicant Married Yes",
    "wosb_married_no": "WOSB Applicant Married No",
}

# Notes payable rows (up to 5)
SBA_NOTES_ROWS = [
    {
        "noteholder": "Names and Addresses of NoteholdersRow{n}",
        "original": "Original BalanceRow{n}",
        "current": "Current BalanceRow{n}",
        "payment": "Payment AmountRow{n}",
        "frequency": "Frequency monthly etcRow{n}",
        "collateral": "How Secured or Endorsed Type of CollateralRow{n}",
    }
]

# Real estate rows (A, B, C)
SBA_REAL_ESTATE_LETTERS = ["A", "B", "C"]


def _fmt_currency(value) -> str:
    """Format a numeric value as integer string (no cents, no commas for AcroForm)."""
    if value is None or value == "":
        return ""
    try:
        return str(int(float(value)))
    except (ValueError, TypeError):
        return str(value)


def _fmt_date(value) -> str:
    """Normalize date to MM/DD/YYYY for SBA form."""
    if not value:
        return datetime.now().strftime("%m/%d/%Y")
    # Already formatted
    if isinstance(value, str) and "/" in value and len(value) == 10:
        return value
    try:
        for fmt in ["%Y-%m-%d", "%m/%d/%Y", "%m%d%Y", "%m-%d-%Y"]:
            try:
                return datetime.strptime(value, fmt).strftime("%m/%d/%Y")
            except ValueError:
                continue
    except Exception:
        pass
    return value


def generate_sba_413(financial_data: Dict[str, Any], output_path: str,
                     template_path: Optional[str] = None) -> str:
    """
    Fill SBA Form 413 AcroForm PDF with financial_data.

    Args:
        financial_data: Structured dict from our intake schema (see below)
        output_path: Where to write the filled PDF
        template_path: Path to blank SBA Form 413 PDF (downloads if None)

    Returns:
        output_path on success

    Required financial_data keys (all optional, missing = blank):
        Personal info: full_name, home_address, city_state_zip, home_phone,
                       business_phone, business_name, business_address,
                       statement_date, business_type (str: llc/corp/scorp/partnership/sole)

        Assets: cash_on_hand, savings_accounts, ira_retirement, accounts_receivable,
                life_insurance_csv, stocks_bonds, real_estate_value, automobiles,
                other_personal_property, other_assets

        Liabilities: accounts_payable, installment_auto, installment_auto_payment,
                     installment_other, installment_other_payment, life_insurance_loans,
                     mortgages, unpaid_taxes, other_liabilities

        Income: salary, net_investment_income, real_estate_income, other_income,
                other_income_description

        Notes payable (list): notes_payable_list
            Each item: {noteholder, original_balance, current_balance, payment, frequency, collateral}

        Real estate (list): real_estate_list
            Each item: {type, address, date_purchased, original_cost, market_value,
                        mortgage_holder, mortgage_account, mortgage_balance,
                        payment_per_month, mortgage_status}

        Signers: signer1_name, signer1_ssn, signer1_date,
                 signer2_name, signer2_ssn, signer2_date

        Sections: section5_description, section6_unpaid_taxes,
                  section7_other_liabilities, section8_life_insurance
    """
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        raise ImportError("pypdf is required: pip install pypdf")

    # --- Get template ---
    if template_path and os.path.exists(template_path):
        reader = PdfReader(template_path)
    else:
        # Download blank SBA Form 413
        import urllib.request
        blank_url = "https://www.sba.gov/sites/default/files/2025-02/SBAForm413.pdf"
        blank_path = "/tmp/sba_413_blank.pdf"
        if not os.path.exists(blank_path):
            print("[forms] Downloading blank SBA Form 413...")
            try:
                urllib.request.urlretrieve(blank_url, blank_path)
            except Exception as e:
                print(f"[forms] WARNING: Could not download SBA Form 413: {e}")
                # Fall back to writing a notice PDF
                return _generate_sba_notice_pdf(financial_data, output_path)
        reader = PdfReader(blank_path)

    writer = PdfWriter()
    writer.append(reader)

    # --- Build field values dict ---
    fields = {}

    # Text fields from schema
    for schema_key, form_field in SBA_FIELD_MAP.items():
        raw = financial_data.get(schema_key)
        if raw is not None and raw != "":
            # Currency fields
            if schema_key in {
                "cash_on_hand", "savings_accounts", "ira_retirement",
                "accounts_receivable", "life_insurance_csv", "stocks_bonds",
                "real_estate_value", "automobiles", "other_personal_property",
                "other_assets", "total_assets", "accounts_payable",
                "notes_payable", "installment_auto", "installment_auto_payment",
                "installment_other", "installment_other_payment",
                "life_insurance_loans", "mortgages", "unpaid_taxes",
                "other_liabilities", "total_liabilities", "net_worth",
                "salary", "net_investment_income", "real_estate_income",
                "other_income", "as_endorser", "legal_claims",
                "federal_tax_provision", "other_special_debt",
            }:
                fields[form_field] = _fmt_currency(raw)
            elif schema_key in {"statement_date", "signer1_date", "signer2_date"}:
                fields[form_field] = _fmt_date(raw)
            else:
                fields[form_field] = str(raw)

    # Checkboxes
    biz_type = financial_data.get("business_type", "").lower()
    for key, form_field in SBA_CHECKBOX_MAP.items():
        if key == "business_type_llc" and biz_type == "llc":
            fields[form_field] = "/Yes"
        elif key == "business_type_corporation" and biz_type in ("corp", "corporation"):
            fields[form_field] = "/Yes"
        elif key == "business_type_scorp" and biz_type in ("scorp", "s-corp"):
            fields[form_field] = "/Yes"
        elif key == "business_type_partnership" and biz_type == "partnership":
            fields[form_field] = "/Yes"
        elif key == "business_type_sole_proprietor" and biz_type in ("sole", "sole_proprietor", "sole proprietor"):
            fields[form_field] = "/Yes"
        elif key == "loan_type_7a" and financial_data.get("loan_type_7a"):
            fields[form_field] = "/Yes"
        elif key == "wosb_married_yes" and financial_data.get("married") == True:
            fields[form_field] = "/Yes"
        elif key == "wosb_married_no" and financial_data.get("married") == False:
            fields[form_field] = "/Yes"

    # Notes payable rows (Section 2)
    notes_list = financial_data.get("notes_payable_list", [])
    for i, note in enumerate(notes_list[:5]):
        n = i + 1
        fields[f"Names and Addresses of NoteholdersRow{n}"] = str(note.get("noteholder", ""))
        fields[f"Original BalanceRow{n}"] = _fmt_currency(note.get("original_balance"))
        fields[f"Current BalanceRow{n}"] = _fmt_currency(note.get("current_balance"))
        fields[f"Payment AmountRow{n}"] = _fmt_currency(note.get("payment"))
        fields[f"Frequency monthly etcRow{n}"] = str(note.get("frequency", "MONTHLY"))
        fields[f"How Secured or Endorsed Type of CollateralRow{n}"] = str(note.get("collateral", ""))

    # Stocks and bonds rows (Section 3) — up to 4
    stocks_list = financial_data.get("stocks_list", [])
    for i, stock in enumerate(stocks_list[:4]):
        n = i + 1
        fields[f"Number of SharesRow{n}"] = str(stock.get("shares", ""))
        fields[f"Name of SecuritiesRow{n}"] = str(stock.get("name", ""))
        fields[f"CostRow{n}"] = _fmt_currency(stock.get("cost"))
        fields[f"Market Value QuotationExchangeRow{n}"] = _fmt_currency(stock.get("market_value"))
        fields[f"Date of QuotationExchangeRow{n}"] = str(stock.get("date", ""))
        fields[f"Total ValueRow{n}"] = _fmt_currency(stock.get("total_value"))

    # Real estate rows (Section 4) — A, B, C
    re_list = financial_data.get("real_estate_list", [])
    for i, prop in enumerate(re_list[:3]):
        letter = SBA_REAL_ESTATE_LETTERS[i]
        fields[f"Property {letter}Type of Real Estate eg Primary Residence Other Residence Rental Property Land etc"] = str(prop.get("type", ""))
        fields[f"Property {letter}Address"] = str(prop.get("address", ""))
        fields[f"Property {letter}Date Purchased_es_:date"] = str(prop.get("date_purchased", ""))
        fields[f"Property {letter}Original Cost"] = _fmt_currency(prop.get("original_cost"))
        fields[f"Property {letter}Present Market Value"] = _fmt_currency(prop.get("market_value"))
        fields[f"Property {letter}Name  Address of Mortgage Holder"] = str(prop.get("mortgage_holder", ""))
        fields[f"Property {letter}Mortgage Account Number"] = str(prop.get("mortgage_account", ""))
        fields[f"Property {letter}Mortgage Balance"] = _fmt_currency(prop.get("mortgage_balance"))
        fields[f"Property {letter}Amount of Payment per MonthYear"] = str(prop.get("payment_per_month", ""))
        fields[f"Property {letter}Status of Mortgage"] = str(prop.get("mortgage_status", ""))

    # --- Write fields to PDF ---
    writer.update_page_form_field_values(writer.pages[0], fields, auto_regenerate=False)
    # Some fields span pages — apply to all pages
    for page in writer.pages[1:]:
        writer.update_page_form_field_values(page, fields, auto_regenerate=False)

    with open(output_path, "wb") as f:
        writer.write(f)

    print(f"[forms] SBA Form 413 written → {output_path}")
    return output_path


def _generate_sba_notice_pdf(financial_data: Dict[str, Any], output_path: str) -> str:
    """Fallback: generate a data summary PDF when blank form isn't available."""
    try:
        from reportlab.lib.pagesizes import LETTER
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.lib.units import inch
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
        from reportlab.lib import colors
    except ImportError:
        raise ImportError("reportlab required")

    doc = SimpleDocTemplate(
        output_path,
        pagesize=LETTER,
        title="SBA Form 413 Data Summary",
        author="Perplexity Computer",
        leftMargin=inch, rightMargin=inch,
        topMargin=inch, bottomMargin=inch,
    )
    styles = getSampleStyleSheet()
    story = []
    story.append(Paragraph("SBA Form 413 — Personal Financial Data Summary", styles["Title"]))
    story.append(Paragraph("MCFL Restaurant Holdings LLC — bleeding.cash Financial Triage", styles["Normal"]))
    story.append(Spacer(1, 0.3 * inch))
    story.append(Paragraph(
        "Note: The blank SBA Form 413 could not be downloaded. "
        "This summary contains the same data for manual entry. "
        "Download the form at sba.gov and transfer these values.",
        styles["Normal"]
    ))
    story.append(Spacer(1, 0.2 * inch))

    # Build data table
    rows = [["Field", "Value"]]
    label_map = {
        "full_name": "Full Name",
        "home_address": "Home Address",
        "city_state_zip": "City, State, Zip",
        "home_phone": "Home Phone",
        "business_phone": "Business Phone",
        "business_name": "Business Name",
        "business_address": "Business Address",
        "statement_date": "Statement Date",
        "cash_on_hand": "Cash on Hand & in Banks",
        "savings_accounts": "Savings Accounts",
        "ira_retirement": "IRA/Retirement Account",
        "accounts_receivable": "Accounts Receivable",
        "stocks_bonds": "Stocks and Bonds",
        "real_estate_value": "Real Estate",
        "automobiles": "Automobiles",
        "other_assets": "Other Assets",
        "total_assets": "Total Assets",
        "accounts_payable": "Accounts Payable",
        "installment_auto": "Installment Account (Auto)",
        "installment_auto_payment": "Auto Monthly Payment",
        "installment_other": "Installment Account (Other)",
        "installment_other_payment": "Other Monthly Payment",
        "mortgages": "Mortgages on Real Estate",
        "unpaid_taxes": "Unpaid Taxes",
        "other_liabilities": "Other Liabilities",
        "total_liabilities": "Total Liabilities",
        "net_worth": "Net Worth",
        "salary": "Salary",
        "net_investment_income": "Net Investment Income",
        "real_estate_income": "Real Estate Income",
        "other_income": "Other Income",
        "signer1_name": "Primary Signer Name",
        "signer2_name": "Co-Signer Name",
    }
    for key, label in label_map.items():
        val = financial_data.get(key, "")
        if val:
            rows.append([label, str(val)])

    t = Table(rows, colWidths=[3 * inch, 3.5 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1B474D")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F7F6F2")]),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#D4D1CA")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(t)
    doc.build(story)
    return output_path


def generate_truist_pfs(financial_data: Dict[str, Any], output_path: str,
                        font_name: str = "Helvetica") -> str:
    """
    Generate a filled Truist Personal Financial Statement PDF.

    This is a ReportLab-generated replica of the Truist PFS form.
    The Truist form is a .doc template that cannot be programmatically filled
    like an AcroForm, so we generate a clean PDF that mirrors its structure.

    Args:
        financial_data: Same schema as generate_sba_413
        output_path: Where to write the PDF
        font_name: ReportLab font name (from setup_fonts())

    Returns:
        output_path on success
    """
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import LETTER
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import inch
        from reportlab.platypus import (
            SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
        )
        from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
    except ImportError:
        raise ImportError("reportlab is required")

    TEAL = colors.HexColor("#1B474D")
    LIGHT_TEAL = colors.HexColor("#BCE2E7")
    GRAY = colors.HexColor("#D4D1CA")
    BG_ALT = colors.HexColor("#F7F6F2")
    WHITE = colors.white
    BLACK = colors.HexColor("#28251D")

    doc = SimpleDocTemplate(
        output_path,
        pagesize=LETTER,
        title="Truist Personal Financial Statement",
        author="Perplexity Computer",
        leftMargin=0.75 * inch,
        rightMargin=0.75 * inch,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
    )

    styles = getSampleStyleSheet()
    body_style = ParagraphStyle("body", fontName=font_name, fontSize=9, leading=13,
                                 textColor=BLACK)
    label_style = ParagraphStyle("label", fontName=font_name + "-Bold" if "Helvetica" not in font_name else "Helvetica-Bold",
                                  fontSize=8, leading=11, textColor=colors.HexColor("#7A7974"))
    header_style = ParagraphStyle("header", fontName="Helvetica-Bold", fontSize=14,
                                   leading=18, textColor=WHITE)
    section_style = ParagraphStyle("section", fontName="Helvetica-Bold", fontSize=9,
                                    leading=13, textColor=WHITE)

    def field_val(key, default=""):
        val = financial_data.get(key, default)
        if val is None:
            return default
        return str(val)

    def money(key, default=""):
        val = financial_data.get(key)
        if val is None or val == "":
            return default
        try:
            return f"${int(float(val)):,}"
        except Exception:
            return str(val)

    story = []

    # ── HEADER ──
    header_data = [
        [Paragraph("TRUIST PERSONAL FINANCIAL STATEMENT", header_style),
         Paragraph("MCFL Restaurant Holdings LLC / bleeding.cash", label_style)]
    ]
    header_table = Table(header_data, colWidths=[4.5 * inch, 2.5 * inch])
    header_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), TEAL),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("TEXTCOLOR", (1, 0), (1, 0), LIGHT_TEAL),
    ]))
    story.append(header_table)
    story.append(Spacer(1, 0.15 * inch))

    # ── SECTION 1 & 2: Applicant Information ──
    def section_header(title):
        t = Table([[Paragraph(title, section_style)]],
                  colWidths=[7 * inch])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), TEAL),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        return t

    def info_row(label, value, label2="", value2=""):
        """Two-column info row with labels above."""
        if label2:
            data = [
                [Paragraph(label, label_style), Paragraph(label2, label_style)],
                [Paragraph(value or "—", body_style), Paragraph(value2 or "—", body_style)],
            ]
            t = Table(data, colWidths=[3.5 * inch, 3.5 * inch])
        else:
            data = [
                [Paragraph(label, label_style)],
                [Paragraph(value or "—", body_style)],
            ]
            t = Table(data, colWidths=[7 * inch])
        t.setStyle(TableStyle([
            ("GRID", (0, 0), (-1, -1), 0.5, GRAY),
            ("BACKGROUND", (0, 0), (-1, 0), BG_ALT),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
        return t

    story.append(section_header("SECTION 1: APPLICANT INFORMATION"))
    story.append(Spacer(1, 0.05 * inch))
    story.append(info_row(
        "Full Name", field_val("full_name"),
        "Co-Applicant Name", field_val("signer2_name")
    ))
    story.append(info_row(
        "Residence Address", field_val("home_address"),
        "City / State / Zip", field_val("city_state_zip")
    ))
    story.append(info_row(
        "Home Phone", field_val("home_phone"),
        "Business Phone", field_val("business_phone")
    ))
    story.append(info_row(
        "Business Name", field_val("business_name"),
        "Business Address", field_val("business_address")
    ))
    story.append(info_row(
        "Statement Date", field_val("statement_date"),
        "Business Type", field_val("business_type").upper() or "LLC"
    ))
    story.append(Spacer(1, 0.15 * inch))

    # ── SECTION 3: Balance Sheet ──
    story.append(section_header("SECTION 3: STATEMENT OF FINANCIAL CONDITION — BALANCE SHEET"))
    story.append(Spacer(1, 0.05 * inch))

    balance_data = [
        [Paragraph("ASSETS", ParagraphStyle("ah", fontName="Helvetica-Bold", fontSize=9, textColor=WHITE)),
         Paragraph("AMOUNT", ParagraphStyle("ah", fontName="Helvetica-Bold", fontSize=9, textColor=WHITE)),
         Paragraph("LIABILITIES", ParagraphStyle("lh", fontName="Helvetica-Bold", fontSize=9, textColor=WHITE)),
         Paragraph("AMOUNT", ParagraphStyle("ah", fontName="Helvetica-Bold", fontSize=9, textColor=WHITE))],
    ]

    asset_rows = [
        ("Cash on Hand & In Banks", money("cash_on_hand")),
        ("Savings Accounts", money("savings_accounts")),
        ("IRAs / 401(k) / Retirement", money("ira_retirement")),
        ("Stocks & Bonds", money("stocks_bonds")),
        ("Real Estate Owned", money("real_estate_value")),
        ("Loans Receivable", money("accounts_receivable")),
        ("Life Insurance Cash Value", money("life_insurance_csv")),
        ("Vehicles / Other Property", money("automobiles")),
        ("Other Assets", money("other_assets")),
        ("", ""),
        ("", ""),
    ]

    liability_rows = [
        ("Secured Notes Payable to Banks", money("notes_payable")),
        ("Unsecured Notes Payable", money("installment_other")),
        ("Credit Cards", money("accounts_payable")),
        ("Auto Installment Loans", money("installment_auto")),
        ("Real Estate Mortgages", money("mortgages")),
        ("Loans Against Life Insurance", money("life_insurance_loans")),
        ("Unpaid Taxes", money("unpaid_taxes")),
        ("Other Debts", money("other_liabilities")),
        ("", ""),
        ("", ""),
        ("", ""),
    ]

    for i, (ar, lr) in enumerate(zip(asset_rows, liability_rows)):
        bg = BG_ALT if i % 2 == 0 else WHITE
        balance_data.append([
            Paragraph(ar[0], body_style),
            Paragraph(ar[1], ParagraphStyle("rv", fontName="Helvetica", fontSize=9,
                                             alignment=2, textColor=BLACK)),
            Paragraph(lr[0], body_style),
            Paragraph(lr[1], ParagraphStyle("rv", fontName="Helvetica", fontSize=9,
                                             alignment=2, textColor=BLACK)),
        ])

    # Totals row
    balance_data.append([
        Paragraph("TOTAL ASSETS", ParagraphStyle("tot", fontName="Helvetica-Bold", fontSize=9, textColor=TEAL)),
        Paragraph(money("total_assets", "$0"), ParagraphStyle("rv", fontName="Helvetica-Bold", fontSize=9,
                                                               alignment=2, textColor=TEAL)),
        Paragraph("TOTAL LIABILITIES", ParagraphStyle("tot", fontName="Helvetica-Bold", fontSize=9, textColor=TEAL)),
        Paragraph(money("total_liabilities", "$0"), ParagraphStyle("rv", fontName="Helvetica-Bold", fontSize=9,
                                                                     alignment=2, textColor=TEAL)),
    ])
    balance_data.append([
        Paragraph("", body_style),
        Paragraph("", body_style),
        Paragraph("NET WORTH", ParagraphStyle("tot", fontName="Helvetica-Bold", fontSize=9, textColor=TEAL)),
        Paragraph(money("net_worth", "$0"), ParagraphStyle("rv", fontName="Helvetica-Bold", fontSize=9,
                                                             alignment=2, textColor=TEAL)),
    ])

    balance_table = Table(balance_data, colWidths=[2.6 * inch, 0.9 * inch, 2.6 * inch, 0.9 * inch])
    ts = TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), TEAL),
        ("GRID", (0, 0), (-1, -1), 0.5, GRAY),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LINEABOVE", (0, -2), (-1, -2), 1, TEAL),
    ])
    for i in range(1, len(balance_data)):
        if i % 2 == 0:
            ts.add("BACKGROUND", (0, i), (-1, i), BG_ALT)
    balance_table.setStyle(ts)
    story.append(balance_table)
    story.append(Spacer(1, 0.15 * inch))

    # ── INCOME & EXPENSE ──
    story.append(section_header("INCOME & EXPENSE STATEMENT"))
    story.append(Spacer(1, 0.05 * inch))

    income_data = [
        [Paragraph("INCOME SOURCE", ParagraphStyle("ih", fontName="Helvetica-Bold", fontSize=9, textColor=WHITE)),
         Paragraph("APPLICANT", ParagraphStyle("ih", fontName="Helvetica-Bold", fontSize=9, textColor=WHITE)),
         Paragraph("EXPENSES", ParagraphStyle("ih", fontName="Helvetica-Bold", fontSize=9, textColor=WHITE)),
         Paragraph("AMOUNT", ParagraphStyle("ih", fontName="Helvetica-Bold", fontSize=9, textColor=WHITE))],
    ]

    income_rows = [
        ("Salary", money("salary")),
        ("Bonuses / Commissions", money("net_investment_income")),
        ("Rental Income", money("real_estate_income")),
        ("Other Income", money("other_income")),
    ]
    expense_rows = [
        ("Rent / Mortgage Payment", money("installment_auto_payment")),
        ("Auto Loan Payment", money("installment_auto_payment")),
        ("Other Installment Payments", money("installment_other_payment")),
        ("", ""),
    ]

    for i, (ir, er) in enumerate(zip(income_rows, expense_rows)):
        bg = BG_ALT if i % 2 == 0 else WHITE
        income_data.append([
            Paragraph(ir[0], body_style),
            Paragraph(ir[1], ParagraphStyle("rv", fontName="Helvetica", fontSize=9,
                                             alignment=2, textColor=BLACK)),
            Paragraph(er[0], body_style),
            Paragraph(er[1], ParagraphStyle("rv", fontName="Helvetica", fontSize=9,
                                             alignment=2, textColor=BLACK)),
        ])

    income_table = Table(income_data, colWidths=[2.6 * inch, 0.9 * inch, 2.6 * inch, 0.9 * inch])
    its = TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), TEAL),
        ("GRID", (0, 0), (-1, -1), 0.5, GRAY),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ])
    for i in range(1, len(income_data)):
        if i % 2 == 0:
            its.add("BACKGROUND", (0, i), (-1, i), BG_ALT)
    income_table.setStyle(its)
    story.append(income_table)
    story.append(Spacer(1, 0.15 * inch))

    # ── NOTES PAYABLE ──
    notes = financial_data.get("notes_payable_list", [])
    if notes:
        story.append(section_header("SCHEDULE E: NOTES PAYABLE TO BANKS / CREDITORS"))
        story.append(Spacer(1, 0.05 * inch))
        notes_data = [
            [Paragraph(h, ParagraphStyle("nh", fontName="Helvetica-Bold", fontSize=8, textColor=WHITE))
             for h in ["Creditor / Noteholder", "Original Balance", "Current Balance", "Payment", "Frequency", "Collateral"]],
        ]
        for note in notes:
            notes_data.append([
                Paragraph(str(note.get("noteholder", "")), body_style),
                Paragraph(f"${int(float(note.get('original_balance', 0) or 0)):,}", body_style),
                Paragraph(f"${int(float(note.get('current_balance', 0) or 0)):,}", body_style),
                Paragraph(f"${int(float(note.get('payment', 0) or 0)):,}", body_style),
                Paragraph(str(note.get("frequency", "Monthly")), body_style),
                Paragraph(str(note.get("collateral", "")), body_style),
            ])
        nt = Table(notes_data, colWidths=[1.8*inch, 1.0*inch, 1.0*inch, 0.8*inch, 0.8*inch, 1.6*inch])
        nt.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), TEAL),
            ("GRID", (0, 0), (-1, -1), 0.5, GRAY),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
        story.append(nt)
        story.append(Spacer(1, 0.15 * inch))

    # ── SIGNATURE BLOCK ──
    story.append(section_header("CERTIFICATION & SIGNATURES"))
    story.append(Spacer(1, 0.05 * inch))
    cert_text = (
        "The undersigned certify that the information provided in this Personal Financial Statement "
        "is true, accurate, and complete to the best of my/our knowledge. I/we authorize Truist "
        "and its affiliates to verify any information contained herein and to obtain credit reports "
        "as needed. MCFL Restaurant Holdings LLC — bleeding.cash Financial Triage Service."
    )
    story.append(Paragraph(cert_text, body_style))
    story.append(Spacer(1, 0.15 * inch))

    sig_data = [
        [Paragraph("Primary Applicant Signature", label_style),
         Paragraph("Date", label_style),
         Paragraph("Co-Applicant Signature", label_style),
         Paragraph("Date", label_style)],
        [Paragraph(f"\n{field_val('signer1_name')}\n", body_style),
         Paragraph(f"\n{field_val('signer1_date', datetime.now().strftime('%m/%d/%Y'))}\n", body_style),
         Paragraph(f"\n{field_val('signer2_name')}\n", body_style),
         Paragraph(f"\n{field_val('signer2_date', datetime.now().strftime('%m/%d/%Y'))}\n", body_style)],
    ]
    sig_table = Table(sig_data, colWidths=[2.2*inch, 1.3*inch, 2.2*inch, 1.3*inch])
    sig_table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.5, GRAY),
        ("BACKGROUND", (0, 0), (-1, 0), BG_ALT),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(sig_table)
    story.append(Spacer(1, 0.1 * inch))

    disclaimer = (
        "<b>DISCLAIMER:</b> This document was auto-populated by MCFL Restaurant Holdings LLC's "
        "bleeding.cash financial triage service based on information provided by the applicant. "
        "This is not legal or financial advice. Verify all figures with a licensed financial advisor "
        "before submitting to any lender. MCFL Restaurant Holdings LLC assumes no liability for errors."
    )
    story.append(Paragraph(disclaimer, ParagraphStyle("disc", fontName="Helvetica", fontSize=7,
                                                        leading=10, textColor=colors.HexColor("#7A7974"))))

    doc.build(story)
    print(f"[forms] Truist PFS written → {output_path}")
    return output_path


def build_financial_data_from_context(context: Dict[str, Any], metrics: Dict[str, Any]) -> Dict[str, Any]:
    """
    Combine context (from the /api/financial-triage request) with
    calculated metrics to build the financial_data dict for form population.

    context keys (from client submission):
        project_name, address, period, email
        personal_info: {
            full_name, signer2_name, home_address, city_state_zip,
            home_phone, business_phone, business_name, business_address,
            business_type, married, signer1_ssn, signer2_ssn
        }
        assets: { ira_retirement, life_insurance_csv, stocks_bonds,
                  real_estate_value, automobiles, other_personal_property,
                  other_assets }
        liabilities: { accounts_payable, installment_auto, installment_auto_payment,
                       installment_other, installment_other_payment, mortgages,
                       unpaid_taxes, other_liabilities }
        income: { salary, net_investment_income, real_estate_income,
                  other_income, other_income_description }
        notes_payable_list: [...]
        real_estate_list: [...]
        stocks_list: [...]
        sections: { section5_description, section6_unpaid_taxes,
                    section7_other_liabilities, section8_life_insurance }
    """
    pi = context.get("personal_info", {})
    assets = context.get("assets", {})
    liabilities = context.get("liabilities", {})
    income = context.get("income", {})
    sections = context.get("sections", {})

    # Calculate totals
    asset_keys = [
        "cash_on_hand", "savings_accounts", "ira_retirement", "accounts_receivable",
        "life_insurance_csv", "stocks_bonds", "real_estate_value",
        "automobiles", "other_personal_property", "other_assets"
    ]
    liability_keys = [
        "accounts_payable", "notes_payable", "installment_auto", "installment_other",
        "life_insurance_loans", "mortgages", "unpaid_taxes", "other_liabilities"
    ]

    def safe_float(d, key):
        try:
            return float(d.get(key) or 0)
        except (ValueError, TypeError):
            return 0.0

    # Cash on hand comes from bank metrics (closing balance) if not provided
    cash = assets.get("cash_on_hand") or metrics.get("closing_balance") or 0

    fd = {
        # Identity
        "full_name": pi.get("full_name", ""),
        "home_address": pi.get("home_address", context.get("address", "")),
        "city_state_zip": pi.get("city_state_zip", ""),
        "home_phone": pi.get("home_phone", ""),
        "business_phone": pi.get("business_phone", ""),
        "business_name": pi.get("business_name", ""),
        "business_address": pi.get("business_address", context.get("address", "")),
        "business_type": pi.get("business_type", "llc"),
        "married": pi.get("married"),
        "statement_date": datetime.now().strftime("%m/%d/%Y"),
        "loan_type_7a": True,

        # Assets
        "cash_on_hand": int(cash),
        "savings_accounts": assets.get("savings_accounts", 0),
        "ira_retirement": assets.get("ira_retirement", 0),
        "accounts_receivable": assets.get("accounts_receivable", 0),
        "life_insurance_csv": assets.get("life_insurance_csv", 0),
        "stocks_bonds": assets.get("stocks_bonds", 0),
        "real_estate_value": assets.get("real_estate_value", 0),
        "automobiles": assets.get("automobiles", 0),
        "other_personal_property": assets.get("other_personal_property", 0),
        "other_assets": assets.get("other_assets", 0),

        # Liabilities
        "accounts_payable": liabilities.get("accounts_payable", 0),
        "notes_payable": liabilities.get("notes_payable", 0),
        "installment_auto": liabilities.get("installment_auto", 0),
        "installment_auto_payment": liabilities.get("installment_auto_payment", 0),
        "installment_other": liabilities.get("installment_other", 0),
        "installment_other_payment": liabilities.get("installment_other_payment", 0),
        "life_insurance_loans": liabilities.get("life_insurance_loans", 0),
        "mortgages": liabilities.get("mortgages", 0),
        "unpaid_taxes": liabilities.get("unpaid_taxes", 0),
        "other_liabilities": liabilities.get("other_liabilities", 0),

        # Income
        "salary": income.get("salary", 0),
        "net_investment_income": income.get("net_investment_income", 0),
        "real_estate_income": income.get("real_estate_income", 0),
        "other_income": income.get("other_income", 0),
        "other_income_description": income.get("other_income_description", ""),

        # Sections
        "section5_description": sections.get("section5_description", "401K, IRA, and Pension"),
        "section6_unpaid_taxes": sections.get("section6_unpaid_taxes", ""),
        "section7_other_liabilities": sections.get("section7_other_liabilities", ""),
        "section8_life_insurance": sections.get("section8_life_insurance", ""),

        # Signers
        "signer1_name": pi.get("signer1_name", pi.get("full_name", "")),
        "signer1_ssn": pi.get("signer1_ssn", ""),
        "signer1_date": datetime.now().strftime("%m/%d/%Y"),
        "signer2_name": pi.get("signer2_name", ""),
        "signer2_ssn": pi.get("signer2_ssn", ""),
        "signer2_date": datetime.now().strftime("%m/%d/%Y"),

        # Lists
        "notes_payable_list": context.get("notes_payable_list", []),
        "real_estate_list": context.get("real_estate_list", []),
        "stocks_list": context.get("stocks_list", []),
    }

    # Calculate totals if not provided
    total_assets = sum([
        safe_float(fd, k) for k in asset_keys
    ])
    total_liabilities = sum([
        safe_float(fd, k) for k in liability_keys
    ])
    # Add notes payable rows to total liabilities
    for note in fd["notes_payable_list"]:
        try:
            total_liabilities += float(note.get("current_balance") or 0)
        except (ValueError, TypeError):
            pass

    fd["total_assets"] = int(total_assets)
    fd["total_liabilities"] = int(total_liabilities)
    fd["net_worth"] = int(total_assets - total_liabilities)

    return fd


if __name__ == "__main__":
    # Quick test with sample data
    test_data = {
        "full_name": "Erik Peter Osol",
        "signer2_name": "Lea Blake Osol",
        "home_address": "205 Odoms Mill Blvd",
        "city_state_zip": "Ponte Vedra Beach, FL 32082",
        "home_phone": "917-355-6404",
        "business_phone": "917-547-1483",
        "business_name": "McFlamingo One LLC",
        "business_address": "880 A1A North Suite 12, Ponte Vedra Beach, FL 32082",
        "business_type": "llc",
        "married": True,
        "statement_date": "03/05/2026",
        "loan_type_7a": True,

        "cash_on_hand": 22000,
        "savings_accounts": 0,
        "ira_retirement": 190000,
        "accounts_receivable": 0,
        "life_insurance_csv": 0,
        "stocks_bonds": 0,
        "real_estate_value": 0,
        "automobiles": 12000,
        "other_personal_property": 0,
        "other_assets": 0,
        "total_assets": 224000,

        "accounts_payable": 130000,
        "notes_payable": 0,
        "installment_auto": 15700,
        "installment_auto_payment": 635,
        "installment_other": 9000,
        "installment_other_payment": 379,
        "life_insurance_loans": 0,
        "mortgages": 0,
        "unpaid_taxes": 0,
        "other_liabilities": 0,
        "total_liabilities": 154700,
        "net_worth": 69300,

        "salary": 167000,
        "net_investment_income": 0,
        "real_estate_income": 0,
        "other_income": 44000,
        "other_income_description": "Incentive Pay",

        "signer1_name": "Lea Blake Osol",
        "signer1_ssn": "115-76-6040",
        "signer1_date": "03/05/2026",
        "signer2_name": "Erik Peter Osol",
        "signer2_ssn": "010-56-1573",
        "signer2_date": "03/05/2026",

        "section5_description": "401K, IRA, and Pension",
        "notes_payable_list": [
            {"noteholder": "USAA", "original_balance": 15000, "current_balance": 9000,
             "payment": 379, "frequency": "MONTHLY", "collateral": "UNSECURED"},
            {"noteholder": "USAA (AUTO LOAN)", "original_balance": 31360, "current_balance": 15700,
             "payment": 635, "frequency": "MONTHLY", "collateral": "BMW X5 2016"},
        ],
        "real_estate_list": [],
        "stocks_list": [],
    }

    print("Testing SBA Form 413 generation...")
    sba_out = generate_sba_413(test_data, "/tmp/test_sba_413.pdf")
    print(f"SBA 413 → {sba_out}")

    print("\nTesting Truist PFS generation...")
    truist_out = generate_truist_pfs(test_data, "/tmp/test_truist_pfs.pdf")
    print(f"Truist PFS → {truist_out}")

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
from typing import Any, Dict, List, Optional

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


# ---------------------------------------------------------------------------
# BLANKS DIR — pre-downloaded bank forms shipped with the repo
# ---------------------------------------------------------------------------
BLANKS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'form_blanks')


def _money(value, default='') -> str:
    """Format as $X,XXX for display fields (BofA/WF use dollar-formatted values)."""
    if value is None or value == '':
        return default
    try:
        return f'${int(float(value)):,}'
    except (ValueError, TypeError):
        return str(value)


# ---------------------------------------------------------------------------
# BANK OF AMERICA PFS
# ---------------------------------------------------------------------------
def generate_bofa_pfs(financial_data: Dict[str, Any], output_path: str,
                      font_name: str = 'Helvetica') -> str:
    """
    Fill BofA Personal Financial Statement AcroForm PDF.
    Blank form: scripts/form_blanks/bofa-pfs.pdf (375 fields)
    """
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        raise ImportError('pypdf required')

    blank = os.path.join(BLANKS_DIR, 'bofa-pfs.pdf')
    if not os.path.exists(blank):
        print(f'[forms] WARNING: BofA blank not found at {blank} — skipping')
        return ''

    reader = PdfReader(blank)
    writer = PdfWriter()
    writer.append(reader)

    def fd(key, default=''):
        v = financial_data.get(key, default)
        return str(v) if v is not None else default

    fields = {
        'Name': fd('full_name'),
        'Social Security Number': fd('signer1_ssn'),
        'Date of Birth': fd('dob'),
        'Current Street Address Where Living': fd('home_address'),
        'Home Phone Include Area Code': fd('home_phone'),
        'Business Phone': fd('business_phone'),
        'Employer If SelfEmployed Name of Business': fd('business_name'),
        'Position': fd('position', 'Owner/Principal'),
        'Name_2': fd('signer2_name'),
        'Social Security Number_2': fd('signer2_ssn'),
        'Date of Birth_2': fd('dob2'),
        'AmountYour Annual Salary': _money(financial_data.get('salary')),
        'AmountYour Coapplicant sGuarantors Annual Salary': '',
        'AmountRental Income': _money(financial_data.get('real_estate_income')),
        'AmountOther Income Please Itemize1': _money(financial_data.get('other_income')),
        'Checking Accounts Schedule A': _money(financial_data.get('cash_on_hand')),
        'Savings Accounts Schedule B': _money(financial_data.get('savings_accounts')),
        'AccountsNotes Receivable Schedule C': _money(financial_data.get('accounts_receivable')),
        'Retirement Accounts Schedule E': _money(financial_data.get('ira_retirement')),
        'Marketable Securities Schedule F': _money(financial_data.get('stocks_bonds')),
        'Real Estate Owned Schedule H': _money(financial_data.get('real_estate_value')),
        'Cash Value of Life Insurance Schedule I': _money(financial_data.get('life_insurance_csv')),
        'Businesses Owned Schedule G': _money(financial_data.get('other_assets')),
        'Net Worth': _money(financial_data.get('net_worth')),
        'Real Estate Payments': _money(financial_data.get('installment_auto_payment')),
        'Do you have loansobligations in any other individual or business name If yes please describe under Additional Details below': 'Yes',
    }

    # Schedule D — Notes payable rows (BofA uses 'RowX' suffix patterns)
    notes = financial_data.get('notes_payable_list', [])
    for i, note in enumerate(notes[:5]):
        n = i + 1
        # Look for BofA-style schedule fields
        fields[f'Payable ToRow{n}'] = str(note.get('noteholder', ''))
        fields[f'High CreditRow{n}'] = _fmt_currency(note.get('original_balance'))
        fields[f'Current BalanceRow{n}'] = _fmt_currency(note.get('current_balance'))
        fields[f'Monthly PaymentRow{n}'] = _fmt_currency(note.get('payment'))

    # Apply to all pages
    for page in writer.pages:
        try:
            writer.update_page_form_field_values(page, fields, auto_regenerate=False)
        except Exception:
            pass

    with open(output_path, 'wb') as f:
        writer.write(f)

    print(f'[forms] BofA PFS written → {output_path}')
    return output_path


# ---------------------------------------------------------------------------
# WELLS FARGO SBA PFS
# ---------------------------------------------------------------------------
def generate_wf_pfs(financial_data: Dict[str, Any], output_path: str,
                    font_name: str = 'Helvetica') -> str:
    """
    Fill Wells Fargo SBA PFS AcroForm PDF.
    Blank form: scripts/form_blanks/wf-pfs.pdf (572 fields)
    """
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        raise ImportError('pypdf required')

    blank = os.path.join(BLANKS_DIR, 'wf-pfs.pdf')
    if not os.path.exists(blank):
        print(f'[forms] WARNING: WF blank not found at {blank} — skipping')
        return ''

    # Parse city/state/zip from city_state_zip if individual fields not provided
    csz = financial_data.get('city_state_zip', '')
    city = financial_data.get('city', '')
    state = financial_data.get('state', '')
    zip_code = financial_data.get('zip_code', '')
    if csz and not city:
        parts = csz.replace(',', ' ').split()
        if len(parts) >= 3:
            zip_code = parts[-1]
            state = parts[-2]
            city = ' '.join(parts[:-2])
        elif len(parts) == 2:
            state = parts[-1]
            city = parts[0]
        elif parts:
            city = csz

    reader = PdfReader(blank)
    writer = PdfWriter()
    writer.append(reader)

    def fd(key, default=''):
        v = financial_data.get(key, default)
        return str(v) if v is not None else default

    fields = {
        'Applicant or Guarantor Full Legal Name': fd('full_name'),
        'Applicant or Guarantor Social Security Number': fd('signer1_ssn'),
        'Applicant or Guarantor Date of Birth': fd('dob'),
        'Applicant or Guarantor Residential Street Address': fd('home_address'),
        'Applicant or Guarantor City': city,
        'Applicant or Guarantor State': state,
        'Applicant or Guarantor Zip Code': zip_code,
        'Preferred Contact Phone_1': fd('home_phone'),
        'Applicant or Guarantor Employer': fd('business_name'),
        'Applicant or Guarantor Position or Title': fd('position', 'Owner'),
        'CO-Applicant or Guarantor Full Legal Name': fd('signer2_name'),
        'CO-Applicant or Guarantor Social Security Number': fd('signer2_ssn'),
        'CO-Applicant or Guarantor Date of Birth': fd('dob2'),
        'Preferred Contact Phone_2': fd('home_phone'),
        'ApplicantSalary': _fmt_currency(financial_data.get('salary')),
        'CoApplicantSalary': '',
        'ApplicantRental Income': _fmt_currency(financial_data.get('real_estate_income')),
        'ApplicantCommissions': _fmt_currency(financial_data.get('net_investment_income')),
        'ApplicantOther Sources ex Contract Income': _fmt_currency(financial_data.get('other_income')),
        'Cash in Bank Accounts schedule 1': _fmt_currency(financial_data.get('cash_on_hand')),
        'Publicly Traded Investments schedule 2': _fmt_currency(financial_data.get('stocks_bonds')),
        'Other Assets schedule 3': _fmt_currency(financial_data.get('other_assets')),
        'Total Assets': _fmt_currency(financial_data.get('total_assets')),
        'Net Worth': _fmt_currency(financial_data.get('net_worth')),
        'Total Revolving Credit schedule A': _fmt_currency(financial_data.get('accounts_payable')),
        'Other Liabilities schedule C': _fmt_currency(financial_data.get('other_liabilities')),
        'Mortgages on Other Real Estate': _fmt_currency(financial_data.get('mortgages')),
        'Date of valuation_1': fd('statement_date'),
        'Date2': fd('statement_date'),
    }

    # Total installment = auto + other
    try:
        total_install = int(float(financial_data.get('installment_auto') or 0)) + int(float(financial_data.get('installment_other') or 0))
        fields['Total Installment Loans schedule B'] = str(total_install)
    except (ValueError, TypeError):
        pass

    # Schedule 1 — Cash accounts
    bank_accounts = financial_data.get('bank_accounts', [])
    if not bank_accounts and financial_data.get('cash_on_hand'):
        bank_accounts = [{'description': 'Checking Account', 'institution': fd('business_name'), 'balance': financial_data.get('cash_on_hand')}]
    for i, acct in enumerate(bank_accounts[:4]):
        n = i + 1
        fields[f'Account DescriptionAccount OwnerRow{n}'] = str(acct.get('description', ''))
        fields[f'Account DescriptionAccount OwnerRow{n}{n}'] = str(acct.get('owner', fd('full_name')))
        fields[f'Name of BankRow{n}'] = str(acct.get('institution', ''))
        fields[f'Current BalanceRow{n}'] = _fmt_currency(acct.get('balance'))

    # Schedule B — Installment loans
    notes = financial_data.get('notes_payable_list', [])
    for i, note in enumerate(notes[:3]):
        n = i + 1
        fields[f'To Whom PayableRow{n}_4'] = str(note.get('noteholder', ''))
        fields[f'Current BalanceRow{n}_4'] = _fmt_currency(note.get('current_balance'))
        fields[f'Monthly PmtRow{n}_4'] = _fmt_currency(note.get('payment'))

    # Signer info
    fields['Applicant or Guarantor Full Legal Name'] = fd('full_name')
    fields['Text111'] = fd('signer1_ssn')

    for page in writer.pages:
        try:
            writer.update_page_form_field_values(page, fields, auto_regenerate=False)
        except Exception:
            pass

    with open(output_path, 'wb') as f:
        writer.write(f)

    print(f'[forms] WF PFS written → {output_path}')
    return output_path


# ---------------------------------------------------------------------------
# CHASE PFS REPLICA
# ---------------------------------------------------------------------------
def generate_chase_pfs(financial_data: Dict[str, Any], output_path: str,
                       font_name: str = 'Helvetica') -> str:
    """
    Generate Chase Personal Financial Statement PDF replica.
    Chase blocks direct PDF downloads, so we generate a matching layout.
    """
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import LETTER
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import inch
        from reportlab.platypus import (
            SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
        )
        from reportlab.lib.enums import TA_CENTER, TA_RIGHT
    except ImportError:
        raise ImportError('reportlab required')

    CHASE_BLUE = colors.HexColor('#117ACA')
    LIGHT_BLUE = colors.HexColor('#E3F0FB')
    GRAY = colors.HexColor('#D4D1CA')
    BG = colors.HexColor('#F7F6F2')
    BLACK = colors.HexColor('#1A1A1A')
    MUTED = colors.HexColor('#7A7974')

    doc = SimpleDocTemplate(
        output_path, pagesize=LETTER,
        title='Chase Personal Financial Statement',
        author='Perplexity Computer',
        leftMargin=0.75 * inch, rightMargin=0.75 * inch,
        topMargin=0.75 * inch, bottomMargin=0.75 * inch,
    )

    W = 7 * inch
    styles = getSampleStyleSheet()
    hdr_s = ParagraphStyle('hdr', fontName='Helvetica-Bold', fontSize=13,
                            textColor=colors.white, leading=17)
    sub_s = ParagraphStyle('sub', fontName='Helvetica', fontSize=9,
                            textColor=LIGHT_BLUE, leading=12)
    body_s = ParagraphStyle('body', fontName='Helvetica', fontSize=9,
                             leading=13, textColor=BLACK)
    lbl_s = ParagraphStyle('lbl', fontName='Helvetica-Bold', fontSize=8,
                            leading=11, textColor=MUTED)
    sec_s = ParagraphStyle('sec', fontName='Helvetica-Bold', fontSize=9,
                            textColor=colors.white, leading=13)
    num_s = ParagraphStyle('num', fontName='Helvetica', fontSize=9,
                            leading=13, textColor=BLACK, alignment=2)

    story = []

    def fd(key, default=''):
        v = financial_data.get(key, default)
        return str(v) if v is not None else default

    def sec_hdr(title):
        t = Table([[Paragraph(title, sec_s)]], colWidths=[W])
        t.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), CHASE_BLUE),
            ('LEFTPADDING', (0, 0), (-1, -1), 8),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ]))
        return t

    def info_row(items):
        """items = [(label, value), ...] in a single row"""
        labels = [Paragraph(i[0], lbl_s) for i in items]
        values = [Paragraph(i[1] or '—', body_s) for i in items]
        col_w = W / len(items)
        t = Table([labels, values], colWidths=[col_w] * len(items))
        t.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), BG),
            ('GRID', (0, 0), (-1, -1), 0.5, GRAY),
            ('LEFTPADDING', (0, 0), (-1, -1), 6),
            ('RIGHTPADDING', (0, 0), (-1, -1), 6),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ]))
        return t

    # HEADER
    hdr = Table([
        [Paragraph('CHASE PERSONAL FINANCIAL STATEMENT', hdr_s)],
        [Paragraph('JPMorgan Chase Bank, N.A. (Confidential) — Auto-populated by bleeding.cash / MCFL Restaurant Holdings LLC', sub_s)],
    ], colWidths=[W])
    hdr.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), CHASE_BLUE),
        ('LEFTPADDING', (0, 0), (-1, -1), 14),
        ('TOPPADDING', (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
    ]))
    story.append(hdr)
    story.append(Spacer(1, 0.15 * inch))

    # SECTION 1 — Individual Info
    story.append(sec_hdr('SECTION 1 — INDIVIDUAL INFORMATION'))
    story.append(Spacer(1, 0.05 * inch))
    story.append(info_row([('Name', fd('full_name')), ('Residence Address', fd('home_address'))]))
    story.append(info_row([('City, State & Zip', fd('city_state_zip')), ('Monthly Mortgage/Rent Payment', _money(financial_data.get('installment_auto_payment')))]))
    story.append(info_row([('Position/Occupation', fd('position', 'Owner/Principal')), ('Business Name', fd('business_name'))]))
    story.append(info_row([('Business Address', fd('business_address')), ('City, State & Zip', fd('city_state_zip'))]))
    story.append(info_row([('Res. Phone', fd('home_phone')), ('Bus. Phone', fd('business_phone')), ('Email', '(on file)')]))
    story.append(info_row([('Social Security No.', fd('signer1_ssn')), ('Date of Birth', fd('dob')), ('Credit Freeze?', 'No')]))
    story.append(Spacer(1, 0.12 * inch))

    # SECTION 2 — Other Party
    story.append(sec_hdr('SECTION 2 — OTHER PARTY / CO-APPLICANT INFORMATION'))
    story.append(Spacer(1, 0.05 * inch))
    story.append(info_row([('Name', fd('signer2_name')), ('Residence Address', fd('home_address'))]))
    story.append(info_row([('City, State & Zip', fd('city_state_zip')), ('Res. Phone', fd('home_phone'))]))
    story.append(info_row([('Position/Occupation', fd('position', 'Owner/Principal')), ('Business Name', fd('business_name'))]))
    story.append(info_row([('Social Security No.', fd('signer2_ssn')), ('Date of Birth', fd('dob2')), ('Credit Freeze?', 'No')]))
    story.append(Spacer(1, 0.12 * inch))

    # SECTION 3 — Balance Sheet
    story.append(sec_hdr('SECTION 3 — STATEMENT OF FINANCIAL CONDITION AS OF ' + fd('statement_date', datetime.now().strftime('%m/%d/%Y'))))
    story.append(Spacer(1, 0.05 * inch))

    bs_hdr = [
        Paragraph('ASSETS (In Dollars — Omit Cents)', ParagraphStyle('bsh', fontName='Helvetica-Bold', fontSize=9, textColor=colors.white)),
        Paragraph('AMOUNT', ParagraphStyle('bsh', fontName='Helvetica-Bold', fontSize=9, textColor=colors.white, alignment=2)),
        Paragraph('LIABILITIES (In Dollars — Omit Cents)', ParagraphStyle('bsh', fontName='Helvetica-Bold', fontSize=9, textColor=colors.white)),
        Paragraph('AMOUNT', ParagraphStyle('bsh', fontName='Helvetica-Bold', fontSize=9, textColor=colors.white, alignment=2)),
    ]

    asset_rows = [
        ('Cash on hand and in banks', _money(financial_data.get('cash_on_hand'))),
        ('U.S. Gov\'t & Marketable Securities (Sch A)', _money(financial_data.get('stocks_bonds'))),
        ('Securities held by broker in margin accounts', ''),
        ('Real estate owned (Schedule B)', _money(financial_data.get('real_estate_value'))),
        ('Partial interest in real estate (Sch C)', ''),
        ('IRA / Retirement accounts', _money(financial_data.get('ira_retirement'))),
        ('Life insurance — cash surrender value', _money(financial_data.get('life_insurance_csv'))),
        ('Automobiles / Personal property', _money(financial_data.get('automobiles'))),
        ('Other assets (itemize)', _money(financial_data.get('other_assets'))),
        ('', ''),
    ]
    liab_rows = [
        ('Notes payable to banks — see Schedule D', _money(financial_data.get('notes_payable'))),
        ('Amounts payable to others — see Schedule D', _money(financial_data.get('accounts_payable'))),
        ('Unpaid income tax', _money(financial_data.get('unpaid_taxes'))),
        ('Real estate mortgages payable', _money(financial_data.get('mortgages'))),
        ('Auto installment account', _money(financial_data.get('installment_auto'))),
        ('Other installment account', _money(financial_data.get('installment_other'))),
        ('Loans against life insurance', _money(financial_data.get('life_insurance_loans'))),
        ('Other debts', _money(financial_data.get('other_liabilities'))),
        ('', ''),
        ('', ''),
    ]

    bs_data = [bs_hdr]
    for ar, lr in zip(asset_rows, liab_rows):
        bs_data.append([
            Paragraph(ar[0], body_s), Paragraph(ar[1], num_s),
            Paragraph(lr[0], body_s), Paragraph(lr[1], num_s),
        ])
    # Totals
    tot_s = ParagraphStyle('tot', fontName='Helvetica-Bold', fontSize=9, textColor=CHASE_BLUE)
    tot_n = ParagraphStyle('totn', fontName='Helvetica-Bold', fontSize=9, textColor=CHASE_BLUE, alignment=2)
    bs_data.append([Paragraph('TOTAL ASSETS', tot_s), Paragraph(_money(financial_data.get('total_assets'), '$0'), tot_n),
                    Paragraph('TOTAL LIABILITIES', tot_s), Paragraph(_money(financial_data.get('total_liabilities'), '$0'), tot_n)])
    bs_data.append([Paragraph('', body_s), Paragraph('', num_s),
                    Paragraph('NET WORTH', tot_s), Paragraph(_money(financial_data.get('net_worth'), '$0'), tot_n)])

    bs_t = Table(bs_data, colWidths=[2.7 * inch, 0.8 * inch, 2.7 * inch, 0.8 * inch])
    bts = TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), CHASE_BLUE),
        ('GRID', (0, 0), (-1, -1), 0.5, GRAY),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 5),
        ('RIGHTPADDING', (0, 0), (-1, -1), 5),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ('LINEABOVE', (0, -2), (-1, -2), 1, CHASE_BLUE),
    ])
    for i in range(1, len(bs_data)):
        if i % 2 == 0:
            bts.add('BACKGROUND', (0, i), (-1, i), BG)
    bs_t.setStyle(bts)
    story.append(bs_t)
    story.append(Spacer(1, 0.15 * inch))

    # SCHEDULE D — Debt
    notes = financial_data.get('notes_payable_list', [])
    if notes:
        story.append(sec_hdr('SCHEDULE D — DEBT WITH BANKS OR FINANCIAL INSTITUTIONS'))
        story.append(Spacer(1, 0.05 * inch))
        sch_hdr = [Paragraph(h, ParagraphStyle('sh', fontName='Helvetica-Bold', fontSize=8, textColor=colors.white))
                   for h in ['Lender / Payable To', 'Banks or Others?', 'Secured/Unsecured', 'High Credit', 'Current Balance', 'Monthly Payment', 'Collateral']]
        sch_data = [sch_hdr]
        for note in notes:
            sch_data.append([
                Paragraph(str(note.get('noteholder', '')), body_s),
                Paragraph('Banks', body_s),
                Paragraph(str(note.get('collateral', 'Unsecured')), body_s),
                Paragraph(_money(note.get('original_balance')), num_s),
                Paragraph(_money(note.get('current_balance')), num_s),
                Paragraph(_money(note.get('payment')), num_s),
                Paragraph(str(note.get('collateral', '')), body_s),
            ])
        sch_t = Table(sch_data, colWidths=[1.5*inch, 0.8*inch, 0.9*inch, 0.8*inch, 0.9*inch, 0.9*inch, 0.9*inch])
        sch_t.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), CHASE_BLUE),
            ('GRID', (0, 0), (-1, -1), 0.5, GRAY),
            ('FONTSIZE', (0, 0), (-1, -1), 8),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 4),
            ('RIGHTPADDING', (0, 0), (-1, -1), 4),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        story.append(sch_t)
        story.append(Spacer(1, 0.15 * inch))

    # SIGNATURE BLOCK
    story.append(sec_hdr('SIGNATURES'))
    story.append(Spacer(1, 0.05 * inch))
    sig_data = [
        [Paragraph('Individual Signature', lbl_s), Paragraph('Date Signed', lbl_s),
         Paragraph('S.S. No.', lbl_s), Paragraph('Date of Birth', lbl_s)],
        [Paragraph(f'\n{fd("full_name")}\n', body_s),
         Paragraph(f'\n{fd("signer1_date", datetime.now().strftime("%m/%d/%Y"))}\n', body_s),
         Paragraph(f'\n{fd("signer1_ssn")}\n', body_s),
         Paragraph(f'\n{fd("dob")}\n', body_s)],
        [Paragraph('Other Party Signature', lbl_s), Paragraph('Date Signed', lbl_s),
         Paragraph('S.S. No.', lbl_s), Paragraph('Date of Birth', lbl_s)],
        [Paragraph(f'\n{fd("signer2_name")}\n', body_s),
         Paragraph(f'\n{fd("signer2_date", datetime.now().strftime("%m/%d/%Y"))}\n', body_s),
         Paragraph(f'\n{fd("signer2_ssn")}\n', body_s),
         Paragraph(f'\n{fd("dob2")}\n', body_s)],
    ]
    sig_t = Table(sig_data, colWidths=[2.0*inch, 1.5*inch, 1.75*inch, 1.75*inch])
    sig_t.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.5, GRAY),
        ('BACKGROUND', (0, 0), (-1, 0), BG),
        ('BACKGROUND', (0, 2), (-1, 2), BG),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]))
    story.append(sig_t)
    story.append(Spacer(1, 0.1 * inch))

    story.append(Paragraph(
        '<b>DISCLAIMER:</b> This document was auto-populated by MCFL Restaurant Holdings LLC (bleeding.cash). '
        'Not legal or financial advice. Verify all figures before submitting to JPMorgan Chase Bank, N.A. '
        'or any other lender. Form 10355 (12/24).',
        ParagraphStyle('disc', fontName='Helvetica', fontSize=7, leading=10, textColor=MUTED)
    ))

    doc.build(story)
    print(f'[forms] Chase PFS written → {output_path}')
    return output_path


# ---------------------------------------------------------------------------
# UNIVERSAL BUSINESS DEBT SCHEDULE
# ---------------------------------------------------------------------------
def generate_business_debt_schedule(financial_data: Dict[str, Any], output_path: str,
                                     font_name: str = 'Helvetica') -> str:
    """Universal Business Debt Schedule — accepted by all lenders."""
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import LETTER
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.lib.units import inch
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
    except ImportError:
        raise ImportError('reportlab required')

    TEAL = colors.HexColor('#1B474D')
    LIGHT = colors.HexColor('#BCE2E7')
    GRAY = colors.HexColor('#D4D1CA')
    BG = colors.HexColor('#F7F6F2')
    BLACK = colors.HexColor('#28251D')
    MUTED = colors.HexColor('#7A7974')

    doc = SimpleDocTemplate(
        output_path, pagesize=LETTER,
        title='Business Debt Schedule', author='Perplexity Computer',
        leftMargin=0.75*inch, rightMargin=0.75*inch,
        topMargin=0.75*inch, bottomMargin=0.75*inch,
    )
    W = 7 * inch
    body_s = ParagraphStyle('b', fontName='Helvetica', fontSize=8, leading=11, textColor=BLACK)
    hdr_s = ParagraphStyle('h', fontName='Helvetica-Bold', fontSize=8, leading=11, textColor=colors.white)
    lbl_s = ParagraphStyle('l', fontName='Helvetica-Bold', fontSize=8, leading=11, textColor=MUTED)
    title_s = ParagraphStyle('t', fontName='Helvetica-Bold', fontSize=14, leading=18, textColor=colors.white)
    sub_s = ParagraphStyle('s', fontName='Helvetica', fontSize=9, leading=13, textColor=LIGHT)
    sec_s = ParagraphStyle('sc', fontName='Helvetica-Bold', fontSize=9, leading=13, textColor=colors.white)

    def fd(key, default=''):
        v = financial_data.get(key, default)
        return str(v) if v is not None else default

    def sec_hdr(title):
        t = Table([[Paragraph(title, sec_s)]], colWidths=[W])
        t.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), TEAL),
            ('LEFTPADDING', (0, 0), (-1, -1), 8),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ]))
        return t

    def debt_table(cols, rows, col_widths):
        if not rows:
            return None
        data = [[Paragraph(c, hdr_s) for c in cols]] + [
            [Paragraph(str(cell or ''), body_s) for cell in row] for row in rows
        ]
        t = Table(data, colWidths=col_widths)
        ts = TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), TEAL),
            ('GRID', (0, 0), (-1, -1), 0.5, GRAY),
            ('FONTSIZE', (0, 0), (-1, -1), 8),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 4),
            ('RIGHTPADDING', (0, 0), (-1, -1), 4),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ])
        for i in range(1, len(data)):
            if i % 2 == 0:
                ts.add('BACKGROUND', (0, i), (-1, i), BG)
        t.setStyle(ts)
        return t

    story = []

    # HEADER
    hdr = Table([
        [Paragraph('BUSINESS DEBT SCHEDULE', title_s)],
        [Paragraph(f'{fd("business_name")} — As of {fd("statement_date", datetime.now().strftime("%m/%d/%Y"))} — bleeding.cash / MCFL Restaurant Holdings LLC', sub_s)],
    ], colWidths=[W])
    hdr.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), TEAL),
        ('LEFTPADDING', (0, 0), (-1, -1), 14),
        ('TOPPADDING', (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
    ]))
    story.append(hdr)
    story.append(Spacer(1, 0.15*inch))

    # Business info row
    info_data = [
        [Paragraph('Business Name', lbl_s), Paragraph('EIN', lbl_s), Paragraph('Business Address', lbl_s), Paragraph('Statement Date', lbl_s)],
        [Paragraph(fd('business_name'), body_s), Paragraph(fd('ein', 'N/A'), body_s),
         Paragraph(fd('business_address'), body_s), Paragraph(fd('statement_date', datetime.now().strftime('%m/%d/%Y')), body_s)],
    ]
    info_t = Table(info_data, colWidths=[2*inch, 1.2*inch, 2.5*inch, 1.3*inch])
    info_t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), BG),
        ('GRID', (0, 0), (-1, -1), 0.5, GRAY),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]))
    story.append(info_t)
    story.append(Spacer(1, 0.15*inch))

    # Get business debts
    business_debts = financial_data.get('business_debts', [])
    notes = financial_data.get('notes_payable_list', [])

    # If no business_debts, infer from notes_payable_list
    if not business_debts and notes:
        business_debts = [{
            'lender': n.get('noteholder', ''),
            'type': 'term_loan',
            'original_balance': n.get('original_balance', 0),
            'current_balance': n.get('current_balance', 0),
            'monthly_payment': n.get('payment', 0),
            'rate': n.get('rate', 'N/A'),
            'maturity_date': n.get('maturity_date', 'N/A'),
            'collateral': n.get('collateral', 'Unsecured'),
        } for n in notes]

    total_monthly = 0

    # Term Loans
    term_loans = [d for d in business_debts if d.get('type', 'term_loan') in ('term_loan', 'loan', '')]
    if term_loans:
        story.append(sec_hdr('TERM LOANS'))
        story.append(Spacer(1, 0.05*inch))
        rows = []
        for d in term_loans:
            mp = float(d.get('monthly_payment', 0) or 0)
            total_monthly += mp
            rows.append([d.get('lender',''), _money(d.get('original_balance')), _money(d.get('current_balance')),
                         str(d.get('rate','N/A')), _money(d.get('monthly_payment')), str(d.get('maturity_date','N/A')), str(d.get('collateral',''))])
        t = debt_table(
            ['Lender', 'Original Balance', 'Current Balance', 'Rate', 'Monthly Payment', 'Maturity', 'Collateral'],
            rows, [1.5*inch, 0.9*inch, 0.9*inch, 0.6*inch, 0.9*inch, 0.7*inch, 1.5*inch]
        )
        if t:
            story.append(t)
            story.append(Spacer(1, 0.1*inch))

    # Lines of Credit
    loc = [d for d in business_debts if d.get('type') in ('line_of_credit', 'loc', 'revolver')]
    if loc:
        story.append(sec_hdr('LINES OF CREDIT'))
        story.append(Spacer(1, 0.05*inch))
        rows = []
        for d in loc:
            mp = float(d.get('monthly_payment', 0) or 0)
            total_monthly += mp
            rows.append([d.get('lender',''), _money(d.get('limit')), _money(d.get('current_balance')),
                         str(d.get('rate','N/A')), _money(d.get('monthly_payment')),
                         'Yes' if d.get('secured') else 'No'])
        t = debt_table(
            ['Lender', 'Credit Limit', 'Current Balance', 'Rate', 'Monthly Payment', 'Secured?'],
            rows, [2.0*inch, 1.0*inch, 1.0*inch, 0.7*inch, 1.1*inch, 1.2*inch]
        )
        if t:
            story.append(t)
            story.append(Spacer(1, 0.1*inch))

    # MCA
    mcas = [d for d in business_debts if d.get('type') in ('mca', 'revenue_based', 'merchant_cash')]
    if mcas:
        story.append(sec_hdr('MERCHANT CASH ADVANCES / REVENUE-BASED FINANCING'))
        story.append(Spacer(1, 0.05*inch))
        rows = []
        for d in mcas:
            mp = float(d.get('daily_payment', d.get('monthly_payment', 0)) or 0)
            total_monthly += mp * 22 if d.get('daily_payment') else mp
            rows.append([d.get('lender',''), _money(d.get('original_balance')), _money(d.get('current_balance')),
                         str(d.get('factor_rate','N/A')), str(d.get('daily_payment','N/A')), str(d.get('remaining_term','N/A'))])
        t = debt_table(
            ['Funder', 'Original Amount', 'Remaining Balance', 'Factor Rate', 'Daily/Weekly Payment', 'Remaining Term'],
            rows, [1.5*inch, 1.0*inch, 1.0*inch, 0.8*inch, 1.2*inch, 1.5*inch]
        )
        if t:
            story.append(t)
            story.append(Spacer(1, 0.1*inch))

    # TOTAL MONTHLY DEBT SERVICE
    story.append(Spacer(1, 0.1*inch))
    total_t = Table([
        [Paragraph('TOTAL MONTHLY DEBT SERVICE', ParagraphStyle('tot', fontName='Helvetica-Bold', fontSize=11, textColor=colors.white)),
         Paragraph(_money(int(total_monthly)), ParagraphStyle('totn', fontName='Helvetica-Bold', fontSize=14, textColor=colors.white, alignment=2))]
    ], colWidths=[5.5*inch, 1.5*inch])
    total_t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), TEAL),
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
        ('TOPPADDING', (0, 0), (-1, -1), 8),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
    ]))
    story.append(total_t)
    story.append(Spacer(1, 0.15*inch))

    # Signature
    story.append(Paragraph(
        'The undersigned certifies that all information provided in this Business Debt Schedule is true, '  
        'accurate, and complete to the best of my/our knowledge.',
        body_s
    ))
    story.append(Spacer(1, 0.2*inch))
    sig_rows = [
        [Paragraph('Authorized Signature', lbl_s), Paragraph('Title', lbl_s), Paragraph('Date', lbl_s)],
        [Paragraph(f'\n{fd("full_name")}\n', body_s), Paragraph(f'\n{fd("position", "Owner")}\n', body_s),
         Paragraph(f'\n{fd("statement_date")}\n', body_s)],
    ]
    sig_t = Table(sig_rows, colWidths=[3*inch, 2*inch, 2*inch])
    sig_t.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.5, GRAY),
        ('BACKGROUND', (0, 0), (-1, 0), BG),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]))
    story.append(sig_t)
    story.append(Spacer(1, 0.1*inch))
    story.append(Paragraph(
        '<b>DISCLAIMER:</b> Auto-populated by MCFL Restaurant Holdings LLC (bleeding.cash). Not legal or financial advice.',
        ParagraphStyle('disc', fontName='Helvetica', fontSize=7, leading=10, textColor=MUTED)
    ))

    doc.build(story)
    print(f'[forms] Business Debt Schedule written → {output_path}')
    return output_path


# ---------------------------------------------------------------------------
# UNIVERSAL PERSONAL DEBT SCHEDULE
# ---------------------------------------------------------------------------
def generate_personal_debt_schedule(financial_data: Dict[str, Any], output_path: str,
                                     font_name: str = 'Helvetica') -> str:
    """Universal Personal Debt Schedule — accepted by all lenders."""
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import LETTER
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.lib.units import inch
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
    except ImportError:
        raise ImportError('reportlab required')

    TEAL = colors.HexColor('#1B474D')
    LIGHT = colors.HexColor('#BCE2E7')
    GRAY = colors.HexColor('#D4D1CA')
    BG = colors.HexColor('#F7F6F2')
    BLACK = colors.HexColor('#28251D')
    MUTED = colors.HexColor('#7A7974')

    doc = SimpleDocTemplate(
        output_path, pagesize=LETTER,
        title='Personal Debt Schedule', author='Perplexity Computer',
        leftMargin=0.75*inch, rightMargin=0.75*inch,
        topMargin=0.75*inch, bottomMargin=0.75*inch,
    )
    W = 7 * inch
    body_s = ParagraphStyle('b', fontName='Helvetica', fontSize=8, leading=11, textColor=BLACK)
    hdr_s = ParagraphStyle('h', fontName='Helvetica-Bold', fontSize=8, leading=11, textColor=colors.white)
    lbl_s = ParagraphStyle('l', fontName='Helvetica-Bold', fontSize=8, leading=11, textColor=MUTED)
    title_s = ParagraphStyle('t', fontName='Helvetica-Bold', fontSize=14, leading=18, textColor=colors.white)
    sub_s = ParagraphStyle('s', fontName='Helvetica', fontSize=9, leading=13, textColor=LIGHT)
    sec_s = ParagraphStyle('sc', fontName='Helvetica-Bold', fontSize=9, leading=13, textColor=colors.white)
    num_s = ParagraphStyle('n', fontName='Helvetica', fontSize=8, leading=11, textColor=BLACK, alignment=2)

    def fd(key, default=''):
        v = financial_data.get(key, default)
        return str(v) if v is not None else default

    def sec_hdr(title):
        t = Table([[Paragraph(title, sec_s)]], colWidths=[W])
        t.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), TEAL),
            ('LEFTPADDING', (0, 0), (-1, -1), 8),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ]))
        return t

    def debt_table(cols, rows, col_widths):
        if not rows:
            return None
        data = [[Paragraph(c, hdr_s) for c in cols]] + [
            [Paragraph(str(cell or ''), body_s if i != len(cols)-1 else num_s) for i, cell in enumerate(row)]
            for row in rows
        ]
        t = Table(data, colWidths=col_widths)
        ts = TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), TEAL),
            ('GRID', (0, 0), (-1, -1), 0.5, GRAY),
            ('FONTSIZE', (0, 0), (-1, -1), 8),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 4),
            ('RIGHTPADDING', (0, 0), (-1, -1), 4),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ])
        for i in range(1, len(data)):
            if i % 2 == 0:
                ts.add('BACKGROUND', (0, i), (-1, i), BG)
        t.setStyle(ts)
        return t

    story = []

    # HEADER
    hdr = Table([
        [Paragraph('PERSONAL DEBT SCHEDULE', title_s)],
        [Paragraph(f'{fd("full_name")} — As of {fd("statement_date", datetime.now().strftime("%m/%d/%Y"))} — bleeding.cash / MCFL Restaurant Holdings LLC', sub_s)],
    ], colWidths=[W])
    hdr.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), TEAL),
        ('LEFTPADDING', (0, 0), (-1, -1), 14),
        ('TOPPADDING', (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
    ]))
    story.append(hdr)
    story.append(Spacer(1, 0.15*inch))

    notes = financial_data.get('notes_payable_list', [])
    real_estate = financial_data.get('real_estate_list', [])
    credit_cards = financial_data.get('credit_cards', [])
    total_monthly = 0

    # Mortgages
    mortgages = [p for p in real_estate if p.get('mortgage_balance') and float(p.get('mortgage_balance', 0) or 0) > 0]
    if mortgages or financial_data.get('mortgages'):
        story.append(sec_hdr('REAL ESTATE / MORTGAGE DEBT'))
        story.append(Spacer(1, 0.05*inch))
        rows = []
        if mortgages:
            for p in mortgages:
                mp_val = p.get('payment_per_month', 0) or 0
                try: total_monthly += float(str(mp_val).replace('$','').replace(',','') or 0)
                except: pass
                rows.append([p.get('address',''), p.get('mortgage_holder',''),
                             _money(p.get('mortgage_balance')), str(mp_val),
                             p.get('type',''), p.get('mortgage_status','Current')])
        elif financial_data.get('mortgages'):
            rows.append(['Primary Residence', 'See notes', _money(financial_data.get('mortgages')),
                         _money(financial_data.get('installment_auto_payment')), 'Residential', 'Current'])
        t = debt_table(
            ['Property Address', 'Lender', 'Current Balance', 'Monthly Payment', 'Type', 'Status'],
            rows, [2.0*inch, 1.2*inch, 1.0*inch, 1.0*inch, 1.0*inch, 0.8*inch]
        )
        if t:
            story.append(t)
            story.append(Spacer(1, 0.1*inch))

    # Auto Loans (collateral contains vehicle keywords)
    vehicle_keywords = ('bmw', 'ford', 'chevy', 'toyota', 'honda', 'car', 'truck', 'auto', 'vehicle', 'suv', 'sedan')
    auto_notes = [n for n in notes if any(k in str(n.get('collateral','')).lower() for k in vehicle_keywords)]
    other_notes = [n for n in notes if n not in auto_notes]

    if auto_notes:
        story.append(sec_hdr('AUTO LOANS'))
        story.append(Spacer(1, 0.05*inch))
        rows = []
        for n in auto_notes:
            mp = float(n.get('payment', 0) or 0)
            total_monthly += mp
            rows.append([str(n.get('collateral','')), str(n.get('noteholder','')),
                         _money(n.get('original_balance')), _money(n.get('current_balance')),
                         _money(n.get('payment')), 'N/A', n.get('frequency','Monthly')])
        t = debt_table(
            ['Vehicle', 'Lender', 'Original', 'Current Balance', 'Monthly Payment', 'Rate', 'Frequency'],
            rows, [1.5*inch, 1.2*inch, 0.8*inch, 0.9*inch, 0.9*inch, 0.7*inch, 1.0*inch]
        )
        if t:
            story.append(t)
            story.append(Spacer(1, 0.1*inch))

    # Credit Cards
    if credit_cards:
        story.append(sec_hdr('CREDIT CARDS / REVOLVING CREDIT'))
        story.append(Spacer(1, 0.05*inch))
        rows = []
        for c in credit_cards:
            mp = float(c.get('minimum_payment', 0) or 0)
            total_monthly += mp
            rows.append([c.get('card',''), _money(c.get('limit')), _money(c.get('balance')),
                         _money(c.get('minimum_payment')), str(c.get('rate','N/A'))])
        t = debt_table(
            ['Card / Lender', 'Credit Limit', 'Current Balance', 'Min. Payment', 'Rate'],
            rows, [2.2*inch, 1.0*inch, 1.1*inch, 1.1*inch, 1.6*inch]
        )
        if t:
            story.append(t)
            story.append(Spacer(1, 0.1*inch))

    # Other Personal Loans
    if other_notes:
        story.append(sec_hdr('PERSONAL LOANS / OTHER INSTALLMENT DEBT'))
        story.append(Spacer(1, 0.05*inch))
        rows = []
        for n in other_notes:
            mp = float(n.get('payment', 0) or 0)
            total_monthly += mp
            rows.append([str(n.get('noteholder','')), _money(n.get('original_balance')),
                         _money(n.get('current_balance')), _money(n.get('payment')),
                         'Unsecured' if str(n.get('collateral','')).upper() == 'UNSECURED' else 'Secured'])
        t = debt_table(
            ['Lender', 'Original', 'Current Balance', 'Monthly Payment', 'Secured?'],
            rows, [2.0*inch, 1.0*inch, 1.2*inch, 1.2*inch, 1.6*inch]
        )
        if t:
            story.append(t)
            story.append(Spacer(1, 0.1*inch))

    # TOTAL MONTHLY OBLIGATIONS
    story.append(Spacer(1, 0.1*inch))
    tot_t = Table([
        [Paragraph('TOTAL MONTHLY OBLIGATIONS', ParagraphStyle('tot', fontName='Helvetica-Bold', fontSize=11, textColor=colors.white)),
         Paragraph(_money(int(total_monthly)), ParagraphStyle('totn', fontName='Helvetica-Bold', fontSize=14, textColor=colors.white, alignment=2))]
    ], colWidths=[5.5*inch, 1.5*inch])
    tot_t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), TEAL),
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
        ('TOPPADDING', (0, 0), (-1, -1), 8),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
    ]))
    story.append(tot_t)
    story.append(Spacer(1, 0.15*inch))

    # Signature
    story.append(Paragraph(
        'The undersigned certifies that all information provided in this Personal Debt Schedule is true, '
        'accurate, and complete to the best of my/our knowledge.',
        body_s
    ))
    story.append(Spacer(1, 0.2*inch))
    sig_rows = [
        [Paragraph('Signature', lbl_s), Paragraph('Print Name', lbl_s), Paragraph('Date', lbl_s), Paragraph('SSN (Last 4)', lbl_s)],
        [Paragraph(f'\n{fd("full_name")}\n', body_s), Paragraph(f'\n{fd("full_name")}\n', body_s),
         Paragraph(f'\n{fd("statement_date")}\n', body_s),
         Paragraph(f'\nXXX-XX-{str(fd("signer1_ssn"))[-4:]}\n', body_s)],
    ]
    sig_t = Table(sig_rows, colWidths=[2.0*inch, 2.0*inch, 1.5*inch, 1.5*inch])
    sig_t.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.5, GRAY),
        ('BACKGROUND', (0, 0), (-1, 0), BG),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]))
    story.append(sig_t)
    story.append(Spacer(1, 0.1*inch))
    story.append(Paragraph(
        '<b>DISCLAIMER:</b> Auto-populated by MCFL Restaurant Holdings LLC (bleeding.cash). Not legal or financial advice.',
        ParagraphStyle('disc', fontName='Helvetica', fontSize=7, leading=10, textColor=MUTED)
    ))

    doc.build(story)
    print(f'[forms] Personal Debt Schedule written → {output_path}')
    return output_path


# ---------------------------------------------------------------------------
# MASTER GENERATOR — generate_all_forms()
# ---------------------------------------------------------------------------
def generate_all_forms(
    financial_data: Dict[str, Any],
    output_dir,
    slug: str,
    ym: str,
    font_name: str,
    selected_forms: Optional[List[str]] = None,
    signature_data: Optional[Dict[str, Any]] = None,
) -> List[str]:
    """
    Generate all requested PFS forms in one call.

    selected_forms: list of codes or None (= all)
        Options: 'sba413', 'truist', 'chase', 'bofa', 'wf',
                 'business_debt', 'personal_debt'

    signature_data: if provided, embed signature into each generated PDF.
        {'image_base64': str, 'signer_name': str, 'date': str,
         'ip_address': str, 'timestamp': str}

    Returns list of generated file paths.
    """
    from pathlib import Path
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    ALL_FORMS = ['sba413', 'truist', 'chase', 'bofa', 'wf', 'business_debt', 'personal_debt']
    forms = [f.lower() for f in (selected_forms or ALL_FORMS)]

    generated = []

    if 'sba413' in forms:
        try:
            path = str(output_dir / f'{slug}-sba-413-{ym}.pdf')
            generate_sba_413(financial_data, path)
            generated.append(path)
        except Exception as e:
            print(f'[forms] SBA 413 error: {e}')

    if 'truist' in forms:
        try:
            path = str(output_dir / f'{slug}-truist-pfs-{ym}.pdf')
            generate_truist_pfs(financial_data, path, font_name)
            generated.append(path)
        except Exception as e:
            print(f'[forms] Truist PFS error: {e}')

    if 'chase' in forms:
        try:
            path = str(output_dir / f'{slug}-chase-pfs-{ym}.pdf')
            generate_chase_pfs(financial_data, path, font_name)
            generated.append(path)
        except Exception as e:
            print(f'[forms] Chase PFS error: {e}')

    if 'bofa' in forms:
        try:
            path = str(output_dir / f'{slug}-bofa-pfs-{ym}.pdf')
            result = generate_bofa_pfs(financial_data, path, font_name)
            if result:
                generated.append(path)
        except Exception as e:
            print(f'[forms] BofA PFS error: {e}')

    if 'wf' in forms:
        try:
            path = str(output_dir / f'{slug}-wf-pfs-{ym}.pdf')
            result = generate_wf_pfs(financial_data, path, font_name)
            if result:
                generated.append(path)
        except Exception as e:
            print(f'[forms] WF PFS error: {e}')

    if 'business_debt' in forms:
        try:
            path = str(output_dir / f'{slug}-business-debt-schedule-{ym}.pdf')
            generate_business_debt_schedule(financial_data, path, font_name)
            generated.append(path)
        except Exception as e:
            print(f'[forms] Business Debt Schedule error: {e}')

    if 'personal_debt' in forms:
        try:
            path = str(output_dir / f'{slug}-personal-debt-schedule-{ym}.pdf')
            generate_personal_debt_schedule(financial_data, path, font_name)
            generated.append(path)
        except Exception as e:
            print(f'[forms] Personal Debt Schedule error: {e}')

    print(f'[forms] Generated {len(generated)} form(s): {[os.path.basename(p) for p in generated]}')

    # Apply e-signatures if provided
    if signature_data and generated:
        try:
            from signature_engine import embed_signature_in_pdf
            signed = []
            for path in generated:
                try:
                    signed_path = path.replace('.pdf', '-signed.pdf')
                    embed_signature_in_pdf(path, signed_path, signature_data)
                    os.remove(path)
                    signed.append(signed_path)
                except Exception as e:
                    print(f'[sig] Could not sign {os.path.basename(path)}: {e}')
                    signed.append(path)  # keep unsigned if sig fails
            generated = signed
            print(f'[sig] Signed {len(generated)} PDF(s)')
        except ImportError:
            print('[sig] signature_engine not available — PDFs unsigned')
        except Exception as e:
            print(f'[sig] Signature error: {e}')

    return generated


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

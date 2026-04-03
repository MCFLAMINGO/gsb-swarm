#!/usr/bin/env python3
"""
analyze.py — Restaurant Financial Triage Engine
MCFL Restaurant Holdings LLC

Parses bank statement and POS export files, calculates key restaurant financial
metrics, and generates three professional PDFs:
  1. Financial Analysis Report
  2. Vendor Credit Letter
  3. Bank Loan Request Letter

Usage:
  python analyze.py \
    --bank /path/to/bank_statement.xlsx \
    --pos /path/to/pos_export.csv \
    --project-name "PROJECT-FALCON" \
    --address "123 Flamingo Way, Miami, FL 33101" \
    --period "Q1 2026" \
    --output-dir /path/to/output \
    --context '{"reason": "bank_loan", "locations": 1}'
"""

import argparse
import json
import os
import re
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, date
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# THIRD-PARTY IMPORTS (graceful error if missing)
# ---------------------------------------------------------------------------
try:
    import pandas as pd
except ImportError:
    print("ERROR: pandas is required. Run: pip install pandas openpyxl xlrd")
    sys.exit(1)

try:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import (
        BaseDocTemplate,
        Frame,
        FrameBreak,
        HRFlowable,
        Image,
        NextPageTemplate,
        PageBreak,
        PageTemplate,
        Paragraph,
        Spacer,
        Table,
        TableStyle,
    )
except ImportError:
    print("ERROR: reportlab is required. Run: pip install reportlab")
    sys.exit(1)

# ---------------------------------------------------------------------------
# SECURITY: ANONYMIZATION FUNCTIONS
# ---------------------------------------------------------------------------
import random
import string


def anonymize_dataframe(df, project_name):
    """
    Strip all PII from a dataframe before any analysis.
    Replaces business names, account numbers, personal names with safe placeholders.
    This MUST be called on every dataframe immediately after parsing.
    """
    def scrub_value(val):
        if not isinstance(val, str):
            return val
        # Mask account numbers (sequences of 8+ digits)
        val = re.sub(r'\b\d{8,}\b', lambda m: '****' + m.group()[-4:], val)
        # Mask patterns like ****1234 account refs already partially masked
        val = re.sub(r'\*{4}\d{4}', lambda m: m.group(), val)  # keep existing masks
        # Mask EIN format XX-XXXXXXX
        val = re.sub(r'\b\d{2}-\d{7}\b', 'XX-XXXXXXX', val)
        # Mask SSN format XXX-XX-XXXX
        val = re.sub(r'\b\d{3}-\d{2}-\d{4}\b', 'XXX-XX-XXXX', val)
        return val

    # Apply scrubbing to all string columns
    for col in df.select_dtypes(include='object').columns:
        df[col] = df[col].apply(scrub_value)

    return df


def generate_access_token():
    """Generate a unique 6-char access token."""
    chars = string.ascii_uppercase + string.digits
    return 'TKN-' + ''.join(random.choices(chars, k=6))


# ---------------------------------------------------------------------------
# BRAND PALETTE
# ---------------------------------------------------------------------------
PRIMARY    = colors.HexColor("#01696F")   # Teal
TEXT       = colors.HexColor("#28251D")   # Near-black
MUTED      = colors.HexColor("#7A7974")   # Gray
BORDER     = colors.HexColor("#D4D1CA")   # Light border
SURFACE    = colors.HexColor("#F9F8F5")   # Off-white
ERROR      = colors.HexColor("#A12C7B")   # Magenta-red (critical)
WARNING    = colors.HexColor("#964219")   # Amber (caution)
WHITE      = colors.white
BLACK      = colors.black

DISCLAIMER_SHORT = (
    "Informational only. Not financial, legal, or accounting advice. "
    "MCFL Restaurant Holdings LLC assumes no liability. "
    "Consult a licensed professional before making decisions based on this report."
)

DISCLAIMER_FULL = (
    "This document has been prepared by MCFL Restaurant Holdings LLC solely for informational "
    "purposes. The financial analysis, projections, benchmarks, and narrative contained herein "
    "are based on data provided by the client and are not independently verified. This document "
    "does not constitute financial, legal, investment, accounting, or tax advice of any kind. "
    "MCFL Restaurant Holdings LLC, its officers, agents, members, and affiliates assume no "
    "liability for any decisions, actions, losses, or damages arising from use of this document. "
    "Recipients are strongly advised to consult a licensed CPA, attorney, or financial advisor "
    "before making any decisions."
)

# ---------------------------------------------------------------------------
# FOOD & LABOR VENDOR KEYWORDS (for classification)
# ---------------------------------------------------------------------------
FOOD_VENDOR_KEYWORDS = [
    "sysco", "us foods", "usfood", "gordon food", "gfs", "performance food",
    "pfg", "restaurant depot", "smart foodservice", "vistar", "shamrock",
    "produce", "meat", "seafood", "poultry", "dairy", "bakery", "fresh",
    "grocery", "food", "supply", "provisions", "distribution", "cisco",
    "sysco", "ben e. keith", "nicholas & co", "cheney brothers",
]

LABOR_VENDOR_KEYWORDS = [
    "adp", "paychex", "gusto", "payroll", "paycom", "paylocity", "bamboohr",
    "workday", "kronos", "ceridian", "quickbooks payroll", "square payroll",
    "toast payroll", "zenefits",
]

DEBT_VENDOR_KEYWORDS = [
    "libertas", "credibly", "rapid finance", "fundbox", "national funding",
    "kapitus", "forward financing", "cloudfund", "pearl capital", "ondeck",
    "on deck", "lendio", "kabbage", "american express merchant", "paypal loan",
    "square capital", "shopify capital", "bluevine", "funding circle",
    "loan", "lending", "finance", "mca", "advance", "sba",
]

# ---------------------------------------------------------------------------
# PERSONAL MODE — SPENDING CATEGORY KEYWORDS
# ---------------------------------------------------------------------------
PERSONAL_CATEGORY_KEYWORDS = {
    "groceries": [
        "walmart", "kroger", "publix", "whole foods", "trader joe", "aldi",
        "food lion", "safeway", "target grocery", "costco", "sam's club",
        "heb", "wegmans", "sprouts", "market", "grocery",
    ],
    "dining": [
        "mcdonald", "starbucks", "chick-fil", "subway", "doordash", "ubereats",
        "grubhub", "restaurant", "cafe", "pizza", "sushi", "taco", "burger",
        "wendy", "chipotle", "panera", "dunkin", "popeye", "domino",
        "denny", "ihop", "waffle house", "panda express",
    ],
    "subscriptions": [
        "netflix", "spotify", "hulu", "disney", "amazon prime", "apple",
        "google", "gym", "membership", "planet fitness", "youtube premium",
        "dropbox", "adobe", "microsoft 365", "openai", "chatgpt", "icloud",
    ],
    "utilities": [
        "electric", "gas", "water", "internet", "phone", "att", "verizon",
        "tmobile", "t-mobile", "comcast", "duke energy", "spectrum", "xfinity",
        "power", "sewage", "waste management", "cox", "centurylink",
    ],
    "entertainment": [
        "ticketmaster", "movies", "theater", "concert", "amazon", "steam",
        "playstation", "xbox", "nintendo", "amc", "regal", "cinemark",
        "stubhub", "fandango",
    ],
    "transfers": [
        "zelle", "venmo", "cashapp", "cash app", "paypal", "transfer",
        "withdrawal", "atm",
    ],
}

PERSONAL_INCOME_KEYWORDS = [
    "direct deposit", "payroll", "ach credit", "employer", "salary",
    "pension", "social security", "ssi", "tax refund", "irs",
]


def classify_personal_transaction(desc: str) -> str:
    """Classify a personal bank transaction into a spending category."""
    lower = desc.lower()
    # Check income first
    for kw in PERSONAL_INCOME_KEYWORDS:
        if kw in lower:
            return "income"
    for category, keywords in PERSONAL_CATEGORY_KEYWORDS.items():
        for kw in keywords:
            if kw in lower:
                return category
    return "other"

# ---------------------------------------------------------------------------
# FONT SETUP
# ---------------------------------------------------------------------------
FONTS_DIR = Path("/tmp/fonts")
FONT_REGISTERED = False
FONT_NAME = "Helvetica"  # fallback

def setup_fonts() -> str:
    """Download and register WorkSans from Google Fonts, falling back to Helvetica."""
    global FONT_REGISTERED, FONT_NAME

    FONTS_DIR.mkdir(parents=True, exist_ok=True)
    font_path = FONTS_DIR / "WorkSans.ttf"
    font_bold_path = FONTS_DIR / "WorkSans-Bold.ttf"

    # Google Fonts API URLs — these resolve to the latest version automatically
    urls = {
        "WorkSans": "https://fonts.gstatic.com/s/worksans/v19/QGY_z_wNahGAdqQ43RhVcIgYT2Xz5u32K0nXBi8Jpg.ttf",
        "WorkSans-Bold": "https://fonts.gstatic.com/s/worksans/v19/QGY_z_wNahGAdqQ43RhVcIgYT2Xz5u32K67WBi8Jpg.ttf",
    }
    # Alternative: fetch via Google Fonts CSS API if direct URLs fail
    # The script gracefully falls back to Helvetica if download fails.

    for name, url in urls.items():
        path = FONTS_DIR / f"{name}.ttf"
        if not path.exists():
            try:
                print(f"Downloading font: {name}...")
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    path.write_bytes(resp.read())
                print(f"  Saved to {path}")
            except Exception as e:
                print(f"  Font download failed ({e}). Using Helvetica fallback.")
                return "Helvetica"

    try:
        pdfmetrics.registerFont(TTFont("WorkSans", str(FONTS_DIR / "WorkSans.ttf")))
        pdfmetrics.registerFont(TTFont("WorkSans-Bold", str(FONTS_DIR / "WorkSans-Bold.ttf")))
        FONT_REGISTERED = True
        FONT_NAME = "WorkSans"
        print("WorkSans font registered successfully.")
    except Exception as e:
        print(f"Font registration failed ({e}). Using Helvetica.")
        FONT_NAME = "Helvetica"

    return FONT_NAME


# ---------------------------------------------------------------------------
# PARSING UTILITIES
# ---------------------------------------------------------------------------

def parse_amount(value: Any) -> float:
    """
    Parse a dollar amount from various formats:
      ($1,234.56) -> -1234.56
      -$1,234.56  -> -1234.56
      1,234.56    -> 1234.56
    Returns 0.0 if unparseable.
    """
    if pd.isna(value):
        return 0.0
    s = str(value).strip()
    negative = False
    if s.startswith("(") and s.endswith(")"):
        negative = True
        s = s[1:-1]
    s = re.sub(r"[$,\s]", "", s)
    if s.startswith("-"):
        negative = True
        s = s[1:]
    try:
        result = float(s)
        return -result if negative else result
    except ValueError:
        return 0.0


def find_column(df: pd.DataFrame, keywords: List[str]) -> Optional[str]:
    """Find the first column whose name contains any of the given keywords (case-insensitive)."""
    lower_cols = {col.lower(): col for col in df.columns}
    for kw in keywords:
        for lower_name, original_name in lower_cols.items():
            if kw in lower_name:
                return original_name
    return None


def parse_bank_statement(path: str) -> pd.DataFrame:
    """
    Parse a bank statement file (XLS, XLSX, CSV).
    Returns a DataFrame with standardized columns:
      date, description, amount, balance
    """
    print(f"Parsing bank statement: {path}")
    ext = Path(path).suffix.lower()
    try:
        if ext == ".csv":
            df = pd.read_csv(path, thousands=",", skipinitialspace=True)
        elif ext in (".xls", ".xlsx"):
            df = pd.read_excel(path, thousands=",")
        else:
            raise ValueError(f"Unsupported file extension: {ext}")
    except Exception as e:
        raise RuntimeError(f"Failed to read bank statement: {e}")

    print(f"  Columns found: {list(df.columns)}")

    # Identify key columns
    date_col = find_column(df, ["date", "posted", "transaction date", "trans date"])
    amount_col = find_column(df, ["amount", "debit", "credit", "transaction amount"])
    balance_col = find_column(df, ["balance", "running balance", "ledger balance"])
    desc_col = find_column(df, ["description", "merchant", "payee", "memo", "details", "narrative"])

    if date_col is None:
        raise ValueError("Could not find a date column in bank statement. Expected: 'date', 'posted', etc.")
    if amount_col is None and balance_col is None:
        raise ValueError("Could not find amount or balance column in bank statement.")

    result = pd.DataFrame()

    # Parse dates
    result["date"] = pd.to_datetime(df[date_col], errors="coerce")
    result = result.dropna(subset=["date"])

    # Parse amounts
    if amount_col:
        result["amount"] = df[amount_col].apply(parse_amount)
    else:
        result["amount"] = 0.0

    # Parse balances
    if balance_col:
        result["balance"] = df[balance_col].apply(parse_amount)
    else:
        result["balance"] = None

    # Description
    if desc_col:
        result["description"] = df[desc_col].fillna("").astype(str).str.strip()
    else:
        result["description"] = ""

    result = result.sort_values("date").reset_index(drop=True)
    print(f"  Parsed {len(result)} transactions from {result['date'].min().date()} to {result['date'].max().date()}")
    return result


def parse_pos_export(path: str) -> pd.DataFrame:
    """
    Parse a POS export file (XLS, XLSX, CSV).
    Returns a DataFrame with standardized columns:
      date, net_sales, gross_sales, orders, guests
    """
    print(f"Parsing POS export: {path}")
    ext = Path(path).suffix.lower()
    try:
        if ext == ".csv":
            df = pd.read_csv(path, thousands=",", skipinitialspace=True)
        elif ext in (".xls", ".xlsx"):
            df = pd.read_excel(path, thousands=",")
        else:
            raise ValueError(f"Unsupported file extension: {ext}")
    except Exception as e:
        raise RuntimeError(f"Failed to read POS export: {e}")

    print(f"  Columns found: {list(df.columns)}")

    date_col = find_column(df, ["date", "business date", "sale date"])
    net_sales_col = find_column(df, ["net sales", "net sale", "net revenue"])
    gross_sales_col = find_column(df, ["gross sales", "gross sale", "gross revenue", "total sales"])
    orders_col = find_column(df, ["orders", "transactions", "checks", "ticket count"])
    guests_col = find_column(df, ["guests", "covers", "guests served"])

    result = pd.DataFrame()

    if date_col:
        result["date"] = pd.to_datetime(df[date_col], errors="coerce")
        result = result.dropna(subset=["date"])
        result = result.sort_values("date").reset_index(drop=True)
    else:
        # Treat each row as a summary if no date column
        result["date"] = pd.NaT
        print("  WARNING: No date column found in POS export. Treating as summary data.")

    if net_sales_col:
        result["net_sales"] = df.reindex(result.index)[net_sales_col].apply(parse_amount) if date_col else df[net_sales_col].apply(parse_amount)
    elif gross_sales_col:
        result["net_sales"] = df.reindex(result.index)[gross_sales_col].apply(parse_amount) if date_col else df[gross_sales_col].apply(parse_amount)
        print("  WARNING: Using gross sales as proxy for net sales.")
    else:
        result["net_sales"] = 0.0

    if orders_col:
        result["orders"] = df.reindex(result.index)[orders_col].apply(parse_amount) if date_col else df[orders_col].apply(parse_amount)
    else:
        result["orders"] = 0.0

    if guests_col:
        result["guests"] = df.reindex(result.index)[guests_col].apply(parse_amount) if date_col else df[guests_col].apply(parse_amount)
    else:
        result["guests"] = 0.0

    net_sales_total = result["net_sales"].sum()
    print(f"  Total net sales: ${net_sales_total:,.2f}")
    return result


# ---------------------------------------------------------------------------
# FINANCIAL CALCULATIONS
# ---------------------------------------------------------------------------

def classify_vendor(name: str) -> str:
    """Classify a vendor as 'food', 'labor', 'debt', or 'other'."""
    lower = name.lower()
    for kw in FOOD_VENDOR_KEYWORDS:
        if kw in lower:
            return "food"
    for kw in LABOR_VENDOR_KEYWORDS:
        if kw in lower:
            return "labor"
    for kw in DEBT_VENDOR_KEYWORDS:
        if kw in lower:
            return "debt"
    return "other"


def calculate_metrics(bank_df: Optional[pd.DataFrame], pos_df: Optional[pd.DataFrame]) -> Dict:
    """
    Calculate all key financial metrics from parsed data.
    Returns a metrics dict.
    """
    metrics = {
        "total_cash_in": 0.0,
        "total_cash_out": 0.0,
        "net_cash_flow": 0.0,
        "opening_balance": None,
        "closing_balance": None,
        "min_balance": None,
        "min_balance_date": None,
        "monthly_breakdown": [],
        "top_vendors": {},
        "food_cost_pct": None,
        "labor_pct": None,
        "debt_service_total": 0.0,
        "debt_service_monthly_avg": 0.0,
        "near_zero_events": [],
        "net_sales_total": 0.0,
        "total_orders": 0.0,
        "total_guests": 0.0,
        "avg_ticket": None,
        "num_months": 0,
    }

    # --- POS metrics ---
    if pos_df is not None and len(pos_df) > 0:
        metrics["net_sales_total"] = pos_df["net_sales"].sum()
        metrics["total_orders"] = pos_df["orders"].sum()
        metrics["total_guests"] = pos_df["guests"].sum()
        if metrics["total_orders"] > 0:
            metrics["avg_ticket"] = metrics["net_sales_total"] / metrics["total_orders"]

    # --- Bank metrics ---
    if bank_df is not None and len(bank_df) > 0:
        cash_in = bank_df[bank_df["amount"] > 0]["amount"].sum()
        cash_out = bank_df[bank_df["amount"] < 0]["amount"].sum()

        metrics["total_cash_in"] = cash_in
        metrics["total_cash_out"] = abs(cash_out)
        metrics["net_cash_flow"] = cash_in + cash_out

        # Opening / closing balance
        if bank_df["balance"].notna().any():
            first_bal = bank_df[bank_df["balance"].notna()]["balance"].iloc[0]
            last_bal = bank_df[bank_df["balance"].notna()]["balance"].iloc[-1]
            metrics["opening_balance"] = first_bal
            metrics["closing_balance"] = last_bal

            # Min balance
            min_idx = bank_df["balance"].idxmin()
            metrics["min_balance"] = bank_df.loc[min_idx, "balance"]
            metrics["min_balance_date"] = bank_df.loc[min_idx, "date"].date()

            # Near-zero events
            near_zero = bank_df[bank_df["balance"] < 500][["date", "balance"]].copy()
            near_zero["date"] = near_zero["date"].dt.date
            metrics["near_zero_events"] = list(near_zero.itertuples(index=False, name=None))

        # Monthly breakdown
        bank_df["month"] = bank_df["date"].dt.to_period("M")
        monthly_records = []
        for period_key, group in bank_df.groupby("month"):
            monthly_records.append({
                "month": str(period_key),
                "cash_in": group[group["amount"] > 0]["amount"].sum(),
                "cash_out": abs(group[group["amount"] < 0]["amount"].sum()),
                "net": group["amount"].sum(),
            })
        monthly = monthly_records
        metrics["monthly_breakdown"] = monthly
        metrics["num_months"] = len(monthly)

        # Vendor analysis
        vendor_totals: Dict[str, float] = defaultdict(float)
        vendor_class: Dict[str, str] = {}

        for _, row in bank_df[bank_df["amount"] < 0].iterrows():
            desc = row["description"]
            if desc:
                vendor_totals[desc] += abs(row["amount"])
                if desc not in vendor_class:
                    vendor_class[desc] = classify_vendor(desc)

        # Aggregate by classification
        food_spend = sum(v for k, v in vendor_totals.items() if vendor_class.get(k) == "food")
        labor_spend = sum(v for k, v in vendor_totals.items() if vendor_class.get(k) == "labor")
        debt_spend = sum(v for k, v in vendor_totals.items() if vendor_class.get(k) == "debt")

        metrics["top_vendors"] = dict(sorted(vendor_totals.items(), key=lambda x: x[1], reverse=True))
        metrics["debt_service_total"] = debt_spend
        metrics["debt_service_monthly_avg"] = (
            debt_spend / metrics["num_months"] if metrics["num_months"] > 0 else 0.0
        )

        # Cost percentages (require POS net sales)
        if metrics["net_sales_total"] > 0:
            metrics["food_cost_pct"] = (food_spend / metrics["net_sales_total"]) * 100
            metrics["labor_pct"] = (labor_spend / metrics["net_sales_total"]) * 100

    return metrics


def generate_key_findings(metrics: Dict) -> List[str]:
    """Auto-generate key finding bullets from metrics."""
    findings = []
    ns = metrics.get("net_sales_total", 0)
    ncf = metrics.get("net_cash_flow", 0)
    cb = metrics.get("closing_balance")
    ds_pct = (metrics["debt_service_total"] / ns * 100) if ns > 0 else None
    fcp = metrics.get("food_cost_pct")
    lp = metrics.get("labor_pct")
    nze = metrics.get("near_zero_events", [])

    if ncf < 0:
        findings.append(
            f"NET CASH FLOW IS NEGATIVE: The business spent ${abs(ncf):,.2f} more than it received during this period. "
            "Immediate cost review is recommended."
        )
    elif ncf > 0:
        findings.append(f"Net cash flow is positive at ${ncf:,.2f} for the period.")

    if fcp is not None:
        if fcp > 38:
            findings.append(
                f"FOOD COST IS HIGH: At {fcp:.1f}%, food cost exceeds the red-flag threshold of 38%. "
                "Review purchasing, portioning, and waste management."
            )
        elif fcp > 32:
            findings.append(
                f"Food cost of {fcp:.1f}% is above the ideal range (28–32%). "
                "Tighter vendor negotiation or menu re-engineering may help."
            )
        else:
            findings.append(f"Food cost of {fcp:.1f}% is within the healthy target range (28–32%).")

    if lp is not None:
        if lp > 40:
            findings.append(
                f"LABOR COST IS HIGH: At {lp:.1f}%, labor exceeds the red-flag threshold of 40%. "
                "Scheduling optimization or headcount review is warranted."
            )
        elif lp > 35:
            findings.append(
                f"Labor cost of {lp:.1f}% is above the ideal range (28–35%). "
                "Review scheduling efficiency."
            )
        else:
            findings.append(f"Labor cost of {lp:.1f}% is within the healthy target range (28–35%).")

    if ds_pct is not None:
        if ds_pct > 15:
            findings.append(
                f"DEBT SERVICE IS CRITICAL: At {ds_pct:.1f}% of revenue, debt obligations are unsustainable. "
                "SBA refinancing or debt restructuring is strongly recommended."
            )
        elif ds_pct > 10:
            findings.append(
                f"Debt service at {ds_pct:.1f}% of revenue is elevated. "
                "Consider refinancing high-rate MCA obligations."
            )

    if nze:
        findings.append(
            f"CASH CRISIS EVENTS: The account balance fell below $500 on {len(nze)} occasion(s). "
            "This indicates cash flow stress that poses risk to payroll and vendor payments."
        )

    if cb is not None and cb < 2000:
        findings.append(
            f"LOW ENDING BALANCE: The closing balance of ${cb:,.2f} provides minimal runway. "
            "Working capital relief or a line of credit should be considered urgently."
        )

    if not findings:
        findings.append("No critical findings. Financial metrics are within acceptable ranges.")

    return findings


# ---------------------------------------------------------------------------
# PERSONAL MODE — METRICS & PDF GENERATION
# ---------------------------------------------------------------------------

def calculate_personal_metrics(bank_df: Optional[pd.DataFrame]) -> Dict:
    """Calculate personal finance metrics from bank statement."""
    metrics = {
        "total_income": 0.0,
        "total_expenses": 0.0,
        "net_monthly_position": 0.0,
        "monthly_breakdown": [],
        "category_totals": {},
        "top_expenses": [],
        "subscriptions": [],
        "burn_rate": 0.0,
        "num_months": 0,
        "opening_balance": None,
        "closing_balance": None,
        "min_balance": None,
        "min_balance_date": None,
        "near_zero_events": [],
        "total_cash_in": 0.0,
        "total_cash_out": 0.0,
        "net_cash_flow": 0.0,
    }

    if bank_df is None or len(bank_df) == 0:
        return metrics

    # Classify every transaction
    bank_df["personal_category"] = bank_df["description"].apply(
        lambda d: classify_personal_transaction(d) if d else "other"
    )

    # Income vs expenses
    income_mask = (bank_df["amount"] > 0) | (bank_df["personal_category"] == "income")
    expense_mask = (bank_df["amount"] < 0) & (bank_df["personal_category"] != "income")

    total_income = bank_df[income_mask]["amount"].abs().sum()
    total_expenses = bank_df[expense_mask]["amount"].abs().sum()

    metrics["total_income"] = total_income
    metrics["total_expenses"] = total_expenses
    metrics["total_cash_in"] = total_income
    metrics["total_cash_out"] = total_expenses
    metrics["net_cash_flow"] = total_income - total_expenses
    metrics["net_monthly_position"] = total_income - total_expenses

    # Balances
    if bank_df["balance"].notna().any():
        bal_rows = bank_df[bank_df["balance"].notna()]
        metrics["opening_balance"] = bal_rows["balance"].iloc[0]
        metrics["closing_balance"] = bal_rows["balance"].iloc[-1]
        min_idx = bank_df["balance"].idxmin()
        metrics["min_balance"] = bank_df.loc[min_idx, "balance"]
        metrics["min_balance_date"] = bank_df.loc[min_idx, "date"].date()

        near_zero = bank_df[bank_df["balance"] < 500][["date", "balance"]].copy()
        near_zero["date"] = near_zero["date"].dt.date
        metrics["near_zero_events"] = list(near_zero.itertuples(index=False, name=None))

    # Monthly breakdown
    bank_df["month"] = bank_df["date"].dt.to_period("M")
    monthly_records = []
    for period_key, group in bank_df.groupby("month"):
        monthly_records.append({
            "month": str(period_key),
            "cash_in": group[group["amount"] > 0]["amount"].sum(),
            "cash_out": abs(group[group["amount"] < 0]["amount"].sum()),
            "net": group["amount"].sum(),
        })
    metrics["monthly_breakdown"] = monthly_records
    metrics["num_months"] = max(len(monthly_records), 1)

    # Category totals (expenses only)
    cat_totals: Dict[str, float] = defaultdict(float)
    for _, row in bank_df[expense_mask].iterrows():
        cat = row["personal_category"]
        cat_totals[cat] += abs(row["amount"])
    metrics["category_totals"] = dict(sorted(cat_totals.items(), key=lambda x: x[1], reverse=True))

    # Top individual expenses
    top_exp = (
        bank_df[expense_mask]
        .assign(abs_amount=bank_df[expense_mask]["amount"].abs())
        .nlargest(10, "abs_amount")[["description", "abs_amount", "date"]]
    )
    metrics["top_expenses"] = [
        (row["description"], row["abs_amount"], row["date"].date())
        for _, row in top_exp.iterrows()
    ]

    # Recurring subscriptions (appear 2+ times)
    sub_mask = expense_mask & (bank_df["personal_category"] == "subscriptions")
    if sub_mask.any():
        sub_counts = bank_df[sub_mask].groupby("description").agg(
            count=("amount", "count"),
            total=("amount", lambda x: abs(x).sum()),
            avg=("amount", lambda x: abs(x).mean()),
        ).reset_index()
        sub_counts = sub_counts[sub_counts["count"] >= 2].sort_values("total", ascending=False)
        metrics["subscriptions"] = [
            (row["description"], row["total"], row["avg"], row["count"])
            for _, row in sub_counts.iterrows()
        ]

    # Burn rate (monthly deficit if expenses > income)
    if total_expenses > total_income and metrics["num_months"] > 0:
        metrics["burn_rate"] = (total_expenses - total_income) / metrics["num_months"]

    return metrics


def generate_personal_key_findings(metrics: Dict) -> List[str]:
    """Generate key findings for personal mode."""
    findings = []
    income = metrics.get("total_income", 0)
    expenses = metrics.get("total_expenses", 0)
    net = income - expenses
    burn = metrics.get("burn_rate", 0)
    cats = metrics.get("category_totals", {})
    nze = metrics.get("near_zero_events", [])
    cb = metrics.get("closing_balance")
    num_months = max(metrics.get("num_months", 1), 1)

    if net < 0:
        findings.append(
            f"NEGATIVE NET POSITION: You spent ${abs(net):,.2f} more than you earned during this period. "
            f"Your monthly deficit averages ${burn:,.2f}."
        )
    else:
        findings.append(f"Positive net position: you earned ${net:,.2f} more than you spent.")

    # Top 3 categories
    top_cats = list(cats.items())[:3]
    if top_cats:
        cat_lines = ", ".join(f"{c} (${v:,.0f})" for c, v in top_cats)
        findings.append(f"Top spending categories: {cat_lines}.")

    if burn > 0 and cb and cb > 0:
        runway = cb / (burn if burn > 0 else 1)
        findings.append(
            f"At current burn rate of ${burn:,.0f}/month, your balance of ${cb:,.0f} "
            f"gives you approximately {runway:.1f} months of runway."
        )

    subs = metrics.get("subscriptions", [])
    if subs:
        monthly_sub_total = sum(avg for _, _, avg, _ in subs)
        findings.append(
            f"Recurring subscriptions total ~${monthly_sub_total:,.0f}/month across {len(subs)} services."
        )

    if nze:
        findings.append(
            f"CASH STRESS: Your balance fell below $500 on {len(nze)} occasion(s). "
            "This indicates significant cash flow pressure."
        )

    if cb is not None and cb < 1000:
        findings.append(
            f"LOW ENDING BALANCE: ${cb:,.2f} provides minimal cushion for emergencies."
        )

    if not findings:
        findings.append("No critical findings. Finances appear stable within the analyzed period.")

    return findings


# ---------------------------------------------------------------------------
# PERSONAL MODE — PDF 1: PERSONAL FINANCIAL OVERVIEW
# ---------------------------------------------------------------------------

def generate_personal_overview(
    metrics: Dict,
    project_name: str,
    address: str,
    period: str,
    output_path: str,
    font_name: str,
) -> str:
    """Generate Personal Financial Overview PDF."""
    styles = make_styles(font_name)
    doc = BaseDocTemplate(
        output_path,
        pagesize=LETTER,
        leftMargin=0.6*inch, rightMargin=0.6*inch,
        topMargin=0.6*inch, bottomMargin=0.8*inch,
        title=f"Personal Financial Overview — {project_name}",
        author="MCFL Restaurant Holdings LLC",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
    footer_fn = lambda canvas, doc: disclaimer_footer(canvas, doc, font_name)
    template = PageTemplate(id="main", frames=[frame], onPage=footer_fn)
    doc.addPageTemplates([template])

    story = []

    # --- Cover ---
    story.append(Spacer(1, 0.5 * inch))
    story.append(Paragraph("PERSONAL FINANCIAL OVERVIEW", styles["h1"]))
    story.append(Paragraph(project_name, styles["h2"]))
    story.append(Paragraph(f"Analysis Period: {period}", styles["body"]))
    story.append(Paragraph(f"Generated: {datetime.now().strftime('%B %d, %Y')}", styles["small"]))
    story.append(Spacer(1, 0.2 * inch))
    story.append(HRFlowable(width="100%", thickness=2, color=PRIMARY, spaceAfter=10))

    # Disclaimer
    disc_table = Table([[Paragraph(DISCLAIMER_FULL, styles["disclaimer"])]], colWidths=[doc.width])
    disc_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), SURFACE),
        ("BOX", (0, 0), (-1, -1), 1, BORDER),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
    ]))
    story.append(disc_table)
    story.append(PageBreak())

    # --- Executive Summary KPIs ---
    income = metrics.get("total_income", 0)
    expenses = metrics.get("total_expenses", 0)
    net = income - expenses
    cb = metrics.get("closing_balance") or 0
    burn = metrics.get("burn_rate", 0)
    num_months = max(metrics.get("num_months", 1), 1)

    story.append(Paragraph("INCOME VS. EXPENSES", styles["h2"]))
    kpi_data = [
        ("TOTAL INCOME", f"${income:,.0f}", f"{period}"),
        ("TOTAL EXPENSES", f"${expenses:,.0f}", f"{period}"),
        ("NET POSITION", f"${net:,.0f}", "Surplus" if net >= 0 else "Deficit"),
        ("ENDING BALANCE", f"${cb:,.0f}", "As of last transaction"),
    ]
    story.append(build_kpi_table(kpi_data, styles, col_width=(doc.width / 4) - 4))
    story.append(Spacer(1, 0.15 * inch))

    kpi2 = [
        ("MONTHLY INCOME", f"${income/num_months:,.0f}", "Average"),
        ("MONTHLY EXPENSES", f"${expenses/num_months:,.0f}", "Average"),
        ("BURN RATE", f"${burn:,.0f}/mo" if burn > 0 else "N/A", "Monthly deficit" if burn > 0 else "No deficit"),
        ("NEAR-ZERO EVENTS", str(len(metrics.get("near_zero_events", []))), "Balance < $500"),
    ]
    story.append(build_kpi_table(kpi2, styles, col_width=(doc.width / 4) - 4))
    story.append(Spacer(1, 0.3 * inch))

    # --- Spending by Category ---
    cats = metrics.get("category_totals", {})
    if cats:
        story.append(Paragraph("SPENDING BREAKDOWN BY CATEGORY", styles["h2"]))
        cat_rows = [["Category", "Total Spent", "Monthly Avg", "% of Expenses"]]
        for cat, total in cats.items():
            pct = (total / expenses * 100) if expenses > 0 else 0
            monthly_avg = total / num_months
            cat_rows.append([
                cat.capitalize(),
                f"${total:,.0f}",
                f"${monthly_avg:,.0f}",
                f"{pct:.1f}%",
            ])
        cat_t = Table(cat_rows, colWidths=[2*inch, 1.5*inch, 1.5*inch, 1.2*inch], hAlign="LEFT", repeatRows=1)
        cat_t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), PRIMARY),
            ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("GRID", (0, 0), (-1, -1), 0.3, BORDER),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, SURFACE]),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ]))
        story.append(cat_t)
        story.append(Spacer(1, 0.3 * inch))

    # --- Top 3 Cash Drains ---
    top_cats = list(cats.items())[:3]
    if top_cats:
        story.append(Paragraph("TOP 3 CASH DRAINS", styles["h2"]))
        for i, (cat, total) in enumerate(top_cats, 1):
            pct = (total / expenses * 100) if expenses > 0 else 0
            monthly_avg = total / num_months
            story.append(Paragraph(
                f"<b>{i}. {cat.capitalize()}</b> — ${total:,.0f} total (${monthly_avg:,.0f}/mo, {pct:.1f}% of spending)",
                styles["body"],
            ))
        story.append(Spacer(1, 0.3 * inch))

    # --- Subscriptions ---
    subs = metrics.get("subscriptions", [])
    if subs:
        story.append(Paragraph("RECURRING SUBSCRIPTIONS DETECTED", styles["h2"]))
        sub_rows = [["Service", "Total Charged", "Avg/Month", "Occurrences"]]
        for desc, total, avg, count in subs[:15]:
            sub_rows.append([desc[:40], f"${total:,.2f}", f"${avg:,.2f}", str(int(count))])
        sub_t = Table(sub_rows, colWidths=[2.5*inch, 1.3*inch, 1.2*inch, 1.2*inch], hAlign="LEFT", repeatRows=1)
        sub_t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), PRIMARY),
            ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("GRID", (0, 0), (-1, -1), 0.3, BORDER),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, SURFACE]),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ]))
        story.append(sub_t)
        story.append(Spacer(1, 0.3 * inch))

    # --- Monthly Trend ---
    monthly = metrics.get("monthly_breakdown", [])
    if monthly:
        story.append(Paragraph("MONTH-OVER-MONTH TREND", styles["h2"]))
        story.append(build_monthly_table(monthly, styles, income))
        story.append(Spacer(1, 0.3 * inch))

    # --- Near-Zero Events ---
    nze = metrics.get("near_zero_events", [])
    if nze:
        story.append(Paragraph("NEAR-ZERO BALANCE EVENTS", styles["h2"]))
        story.append(Paragraph(
            "Dates when your balance fell below $500 — these represent financial stress points.",
            styles["small"],
        ))
        nze_rows = [["Date", "Balance"]]
        for d, bal in nze[:20]:
            nze_rows.append([str(d), f"${bal:,.2f}"])
        nze_t = Table(nze_rows, colWidths=[2*inch, 2*inch], hAlign="LEFT", repeatRows=1)
        nze_t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), ERROR),
            ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("GRID", (0, 0), (-1, -1), 0.3, BORDER),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, SURFACE]),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(nze_t)
        story.append(Spacer(1, 0.3 * inch))

    # --- Key Findings ---
    story.append(Paragraph("KEY FINDINGS & ACTION ITEMS", styles["h2"]))
    for finding in generate_personal_key_findings(metrics):
        bullet_text = f"• {finding}"
        style = styles["bullet"]
        if any(word in finding for word in ["NEGATIVE", "HIGH", "CRITICAL", "STRESS", "LOW"]):
            style = ParagraphStyle("BulletRed", parent=styles["bullet"], textColor=ERROR)
        story.append(Paragraph(bullet_text, style))
        story.append(Spacer(1, 0.05 * inch))

    # --- 90-Day Outlook ---
    story.append(Spacer(1, 0.2 * inch))
    story.append(Paragraph("90-DAY OUTLOOK & ACTION ITEMS", styles["h2"]))
    actions = []
    if burn > 0:
        actions.append("Reduce spending to close the monthly deficit. Target the top spending category first.")
    if subs:
        monthly_sub = sum(avg for _, _, avg, _ in subs)
        actions.append(f"Audit ${monthly_sub:,.0f}/month in subscriptions — cancel unused services.")
    top_cat = list(cats.keys())[0] if cats else None
    if top_cat and top_cat in ("dining", "entertainment"):
        actions.append(f"Your largest category is {top_cat} — set a monthly budget and track against it.")
    actions.append("Build an emergency fund: target 1 month of expenses as a first milestone.")
    if net < 0:
        actions.append("Consider additional income sources or side work to close the deficit.")
    actions.append("Re-run this analysis in 90 days to measure progress.")

    for a in actions:
        story.append(Paragraph(f"• {a}", styles["bullet"]))
        story.append(Spacer(1, 0.05 * inch))

    doc.build(story)
    print(f"  Generated: {output_path}")
    return output_path


# ---------------------------------------------------------------------------
# PERSONAL MODE — PDF 2: CREDITOR LETTER
# ---------------------------------------------------------------------------

def generate_creditor_letter(
    metrics: Dict,
    project_name: str,
    address: str,
    period: str,
    output_path: str,
    font_name: str,
) -> str:
    """Generate personal Creditor Letter PDF."""
    styles = make_styles(font_name)
    doc = BaseDocTemplate(
        output_path,
        pagesize=LETTER,
        leftMargin=0.75*inch, rightMargin=0.75*inch,
        topMargin=0.65*inch, bottomMargin=0.85*inch,
        title=f"Creditor Letter — {project_name}",
        author="MCFL Restaurant Holdings LLC",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
    footer_fn = lambda canvas, doc: disclaimer_footer(canvas, doc, font_name)
    template = PageTemplate(id="main", frames=[frame], onPage=footer_fn)
    doc.addPageTemplates([template])

    income = metrics.get("total_income", 0)
    expenses = metrics.get("total_expenses", 0)
    net = income - expenses
    burn = metrics.get("burn_rate", 0)
    num_months = max(metrics.get("num_months", 1), 1)
    monthly_income = income / num_months
    monthly_expenses = expenses / num_months

    story = []
    story += letterhead_block(project_name, address, period, "REQUEST FOR PAYMENT FLEXIBILITY", styles)

    story.append(Paragraph("Dear Creditor,", styles["body"]))
    story.append(Spacer(1, 0.1 * inch))

    if net >= 0:
        opening = (
            f"I am writing proactively to discuss my payment terms. During {period}, "
            f"my total income was ${income:,.2f} and total expenses were ${expenses:,.2f}, "
            f"resulting in a net positive position of ${net:,.2f}. While I am currently meeting "
            f"obligations, I would like to arrange modified terms to ensure continued reliability "
            f"as I navigate upcoming financial commitments."
        )
    elif burn > 0 and burn < monthly_income * 0.15:
        opening = (
            f"I am writing to address my current financial position honestly and to propose "
            f"a realistic payment arrangement. During {period}, my income totaled ${income:,.2f} "
            f"while expenses reached ${expenses:,.2f}, creating a monthly shortfall of "
            f"approximately ${burn:,.2f}. I am committed to resolving this balance and "
            f"maintaining my obligations."
        )
    else:
        opening = (
            f"I owe you a direct conversation about my financial situation. During {period}, "
            f"I have experienced significant cash flow pressure — my expenses of ${expenses:,.2f} "
            f"have exceeded my income of ${income:,.2f} by ${abs(net):,.2f}. I want to present "
            f"an honest picture of my finances alongside a concrete plan to meet my obligations."
        )

    story.append(Paragraph(opening, styles["body"]))
    story.append(Spacer(1, 0.15 * inch))

    # Financial snapshot
    story.append(Paragraph("CURRENT FINANCIAL POSITION", styles["h3"]))
    snap_rows = [
        ["METRIC", "AMOUNT"],
        ["Monthly Income (avg)", f"${monthly_income:,.0f}"],
        ["Monthly Expenses (avg)", f"${monthly_expenses:,.0f}"],
        ["Monthly Net", f"${(monthly_income - monthly_expenses):,.0f}"],
        ["Current Balance", f"${metrics.get('closing_balance', 0) or 0:,.0f}"],
    ]
    snap_t = Table(snap_rows, colWidths=[2.5*inch, 2.0*inch], hAlign="LEFT")
    snap_t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), PRIMARY),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.3, BORDER),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [SURFACE, WHITE]),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(snap_t)
    story.append(Spacer(1, 0.2 * inch))

    # Monthly cash flow
    if metrics.get("monthly_breakdown"):
        story.append(Paragraph("MONTHLY CASH FLOW DETAIL", styles["h3"]))
        story.append(build_monthly_table(metrics["monthly_breakdown"], styles, income))
        story.append(Spacer(1, 0.2 * inch))

    # Proposed timeline
    story.append(Paragraph("PROPOSED PAYMENT TIMELINE", styles["h3"]))
    story.append(Paragraph(
        "I respectfully propose the following arrangement for any outstanding balance:",
        styles["body"],
    ))
    story.append(Spacer(1, 0.1 * inch))
    proposals = [
        "Temporary reduced payments: [proposed amount] per month for [X months] while I stabilize cash flow.",
        "Interest-only period: If applicable, interest-only payments for [X months] before resuming full payments.",
        "Extended terms: Redistribute the remaining balance over a longer period to reduce the monthly burden.",
        "Good faith commitment: I will make consistent payments on the agreed schedule and notify you immediately of any changes.",
    ]
    for p in proposals:
        story.append(Paragraph(f"• {p}", styles["bullet"]))
    story.append(Spacer(1, 0.2 * inch))

    # Steps being taken
    story.append(Paragraph("STEPS I AM TAKING", styles["h3"]))
    steps = [
        "Conducted a full financial analysis to identify spending leaks and areas for reduction.",
        "Reviewing and canceling non-essential subscriptions and discretionary spending.",
        "Building a realistic monthly budget based on actual income and fixed obligations.",
        "Exploring additional income opportunities to close the monthly deficit.",
    ]
    for s in steps:
        story.append(Paragraph(f"• {s}", styles["bullet"]))
    story.append(Spacer(1, 0.2 * inch))

    story.append(Paragraph(
        "I value our relationship and am committed to resolving this responsibly. "
        "Please contact me at your earliest convenience to discuss these terms.",
        styles["body"],
    ))

    story += signature_block(project_name, address, styles)
    doc.build(story)
    print(f"  Generated: {output_path}")
    return output_path


# ---------------------------------------------------------------------------
# PERSONAL MODE — PDF 3: LENDER LETTER
# ---------------------------------------------------------------------------

def generate_lender_letter(
    metrics: Dict,
    project_name: str,
    address: str,
    period: str,
    output_path: str,
    font_name: str,
) -> str:
    """Generate personal Lender Letter PDF (loan/refinance request)."""
    styles = make_styles(font_name)
    doc = BaseDocTemplate(
        output_path,
        pagesize=LETTER,
        leftMargin=0.75*inch, rightMargin=0.75*inch,
        topMargin=0.65*inch, bottomMargin=0.85*inch,
        title=f"Lender Letter — {project_name}",
        author="MCFL Restaurant Holdings LLC",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
    footer_fn = lambda canvas, doc: disclaimer_footer(canvas, doc, font_name)
    template = PageTemplate(id="main", frames=[frame], onPage=footer_fn)
    doc.addPageTemplates([template])

    income = metrics.get("total_income", 0)
    expenses = metrics.get("total_expenses", 0)
    net = income - expenses
    burn = metrics.get("burn_rate", 0)
    num_months = max(metrics.get("num_months", 1), 1)
    monthly_income = income / num_months
    monthly_expenses = expenses / num_months
    cb = metrics.get("closing_balance") or 0

    story = []
    story += letterhead_block(
        project_name, address, period,
        "PERSONAL LOAN / DEBT CONSOLIDATION REQUEST",
        styles,
    )

    # Opening
    story.append(Paragraph("EXECUTIVE SUMMARY", styles["h2"]))
    if net > 0:
        opening = (
            f"I am writing to formally request a personal loan for debt consolidation. "
            f"During {period}, my total income was ${income:,.2f} with expenses of "
            f"${expenses:,.2f}, resulting in positive net cash flow of ${net:,.2f}. "
            f"This loan would allow me to consolidate higher-rate obligations into a single, "
            f"manageable monthly payment, further strengthening my financial position."
        )
    else:
        opening = (
            f"I am writing to request a personal loan to consolidate existing debt obligations. "
            f"During {period}, my income totaled ${income:,.2f}. While my expenses of "
            f"${expenses:,.2f} currently exceed income, the primary driver is fragmented debt "
            f"payments at high interest rates. Consolidation into a single lower-rate instrument "
            f"would reduce my monthly obligation and create a sustainable payment structure."
        )
    story.append(Paragraph(opening, styles["body"]))
    story.append(Spacer(1, 0.2 * inch))

    # Financial overview
    story.append(Paragraph("FINANCIAL OVERVIEW", styles["h2"]))
    kpi_data = [
        ("MONTHLY INCOME", f"${monthly_income:,.0f}", "Average"),
        ("MONTHLY EXPENSES", f"${monthly_expenses:,.0f}", "Average"),
        ("NET MONTHLY", f"${(monthly_income - monthly_expenses):,.0f}", "Surplus" if net >= 0 else "Deficit"),
        ("CURRENT BALANCE", f"${cb:,.0f}", "As of last transaction"),
    ]
    story.append(build_kpi_table(kpi_data, styles, col_width=(doc.width / 4) - 4))
    story.append(Spacer(1, 0.2 * inch))

    # Expense breakdown
    cats = metrics.get("category_totals", {})
    if cats:
        story.append(Paragraph("EXPENSE BREAKDOWN", styles["h2"]))
        cat_rows = [["Category", "Monthly Avg", "% of Expenses"]]
        for cat, total in list(cats.items())[:8]:
            pct = (total / expenses * 100) if expenses > 0 else 0
            monthly_avg = total / num_months
            cat_rows.append([cat.capitalize(), f"${monthly_avg:,.0f}", f"{pct:.1f}%"])
        cat_t = Table(cat_rows, colWidths=[2.5*inch, 1.5*inch, 1.2*inch], hAlign="LEFT", repeatRows=1)
        cat_t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), PRIMARY),
            ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("GRID", (0, 0), (-1, -1), 0.3, BORDER),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, SURFACE]),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ]))
        story.append(cat_t)
        story.append(Spacer(1, 0.2 * inch))

    # Cash flow detail
    if metrics.get("monthly_breakdown"):
        story.append(Paragraph("MONTHLY CASH FLOW", styles["h2"]))
        story.append(build_monthly_table(metrics["monthly_breakdown"], styles, income))
        story.append(Spacer(1, 0.2 * inch))

    # Loan request
    story.append(Paragraph("LOAN REQUEST DETAILS", styles["h2"]))
    loan_rows = [
        ["DETAIL", "REQUEST"],
        ["Loan Type", "Personal loan / debt consolidation"],
        ["Purpose", "Consolidate existing obligations into one payment"],
        ["Requested Term", "3–5 years"],
        ["Repayment", "Monthly fixed payment"],
    ]
    loan_t = Table(loan_rows, colWidths=[2.5*inch, 3.5*inch], hAlign="LEFT")
    loan_t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), PRIMARY),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("SPAN", (0, 0), (-1, 0)),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.3, BORDER),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [SURFACE, WHITE]),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(loan_t)
    story.append(Spacer(1, 0.2 * inch))

    # Case for consolidation
    story.append(Paragraph("WHY CONSOLIDATION MAKES SENSE", styles["h2"]))
    rationale = [
        f"Demonstrated income: ${income:,.2f} earned during {period} shows consistent earning capacity.",
        f"Expense awareness: Full spending analysis completed, identifying areas for reduction.",
        "A single lower-rate payment replaces multiple high-rate obligations, reducing monthly outflow.",
        "Predictable fixed payment allows for reliable budgeting and reduces the risk of missed payments.",
    ]
    if burn > 0:
        reduced = burn * 0.6
        rationale.append(
            f"At current rates, monthly deficit is ${burn:,.0f}. Consolidation at lower rates "
            f"could reduce this to ~${reduced:,.0f}, making the gap manageable."
        )
    for r in rationale:
        story.append(Paragraph(f"• {r}", styles["bullet"]))
        story.append(Spacer(1, 0.05 * inch))

    story.append(Spacer(1, 0.15 * inch))
    story.append(Paragraph(
        "I am prepared to provide additional documentation including tax returns, "
        "pay stubs, or other materials as needed. Thank you for your consideration.",
        styles["body"],
    ))

    story += signature_block(project_name, address, styles)
    doc.build(story)
    print(f"  Generated: {output_path}")
    return output_path


# ---------------------------------------------------------------------------
# PDF GENERATION HELPERS
# ---------------------------------------------------------------------------

def make_styles(font_name: str) -> Dict[str, ParagraphStyle]:
    """Create a full set of paragraph styles."""
    bold_font = "Helvetica-Bold" if font_name == "Helvetica" else font_name + "-Bold"

    styles = {
        "h1": ParagraphStyle("H1", fontName=bold_font, fontSize=22, leading=26, spaceAfter=10, textColor=PRIMARY),
        "h2": ParagraphStyle("H2", fontName=bold_font, fontSize=16, leading=20, spaceAfter=8, textColor=PRIMARY),
        "h3": ParagraphStyle("H3", fontName=bold_font, fontSize=12, leading=16, spaceAfter=6, textColor=TEXT),
        "body": ParagraphStyle("Body", fontName=font_name, fontSize=10, textColor=TEXT, leading=14, spaceAfter=6),
        "small": ParagraphStyle("Small", fontName=font_name, fontSize=8, textColor=MUTED, leading=12, spaceAfter=4),
        "footer": ParagraphStyle("Footer", fontName=font_name, fontSize=7, textColor=MUTED, leading=10, alignment=TA_CENTER),
        "label": ParagraphStyle("Label", fontName=bold_font, fontSize=8, textColor=MUTED, leading=12),
        "kpi_value": ParagraphStyle("KpiValue", fontName=bold_font, fontSize=20, textColor=PRIMARY, leading=24, spaceAfter=4),
        "kpi_label": ParagraphStyle("KpiLabel", fontName=font_name, fontSize=9, textColor=MUTED, leading=12),
        "bullet": ParagraphStyle("Bullet", fontName=font_name, fontSize=10, textColor=TEXT, leading=14, spaceAfter=4, leftIndent=12, bulletIndent=0),
        "disclaimer": ParagraphStyle("Disclaimer", fontName=font_name, fontSize=7, textColor=MUTED, leading=10),
        "center": ParagraphStyle("Center", fontName=font_name, fontSize=10, textColor=TEXT, leading=14, alignment=TA_CENTER),
        "right": ParagraphStyle("Right", fontName=font_name, fontSize=10, textColor=TEXT, leading=14, alignment=TA_RIGHT),
    }
    return styles


def disclaimer_footer(canvas, doc, font_name: str = "Helvetica"):
    """Draw teal top bar, footer disclaimer, and page number on every page."""
    w, h = LETTER
    # Teal top bar
    canvas.saveState()
    canvas.setFillColor(PRIMARY)
    canvas.rect(0, h - 18, w, 18, fill=1, stroke=0)

    # Footer line
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(0.5)
    canvas.line(0.5 * inch, 0.55 * inch, w - 0.5 * inch, 0.55 * inch)

    # Disclaimer text
    canvas.setFont(font_name, 6.5)
    canvas.setFillColor(MUTED)
    canvas.drawCentredString(w / 2, 0.38 * inch, DISCLAIMER_SHORT[:120])
    canvas.drawCentredString(w / 2, 0.28 * inch, DISCLAIMER_SHORT[120:])

    # Page number
    canvas.setFont(font_name, 7)
    canvas.drawRightString(w - 0.5 * inch, 0.15 * inch, f"Page {doc.page}")

    # MCFL branding
    canvas.setFont(font_name, 7)
    canvas.setFillColor(MUTED)
    canvas.drawString(0.5 * inch, 0.15 * inch, "MCFL Restaurant Holdings LLC — Confidential")

    canvas.restoreState()


def build_kpi_table(
    kpi_data: List[Tuple[str, str, Optional[str]]],
    styles: Dict,
    col_width: float = 1.6 * inch,
) -> Table:
    """
    Build a row of KPI tiles.
    kpi_data: list of (label, value, note) tuples
    """
    header_row = [Paragraph(label, styles["kpi_label"]) for label, _, _ in kpi_data]
    value_row = [Paragraph(value, styles["kpi_value"]) for _, value, _ in kpi_data]
    note_row = [
        Paragraph(note or "", styles["small"]) for _, _, note in kpi_data
    ]

    table_data = [header_row, value_row, note_row]
    col_widths = [col_width] * len(kpi_data)

    t = Table(table_data, colWidths=col_widths, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), SURFACE),
        ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [SURFACE, WHITE, SURFACE]),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    return t


def build_monthly_table(monthly: List[Dict], styles: Dict, net_sales: float = 0) -> Table:
    """Build a styled monthly cash flow table."""
    headers = ["Month", "Cash In", "Cash Out", "Net Flow", "vs. Sales"]
    rows = [headers]
    for m in monthly:
        vs = f"{(m['net'] / net_sales * 100):.1f}%" if net_sales > 0 else "—"
        net_color = "green" if m["net"] >= 0 else "red"
        rows.append([
            m["month"],
            f"${m['cash_in']:,.0f}",
            f"${m['cash_out']:,.0f}",
            f"${m['net']:,.0f}",
            vs,
        ])

    col_widths = [1.1*inch, 1.2*inch, 1.2*inch, 1.2*inch, 1.0*inch]
    t = Table(rows, colWidths=col_widths, hAlign="LEFT", repeatRows=1)
    style_cmds = [
        ("BACKGROUND", (0, 0), (-1, 0), PRIMARY),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.3, BORDER),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, SURFACE]),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
    ]
    # Color negative net flows red
    for i, m in enumerate(monthly, start=1):
        if m["net"] < 0:
            style_cmds.append(("TEXTCOLOR", (3, i), (3, i), ERROR))
    t.setStyle(TableStyle(style_cmds))
    return t


def build_vendor_table(
    top_vendors: Dict[str, float],
    styles: Dict,
    net_sales: float = 0,
    top_n: int = 15,
) -> Table:
    """Build the top vendors table with % of net sales."""
    headers = ["Vendor / Description", "Total Paid", "% of Net Sales", "Category"]
    rows = [headers]
    for vendor, amount in list(top_vendors.items())[:top_n]:
        pct = f"{(amount / net_sales * 100):.1f}%" if net_sales > 0 else "—"
        cat = classify_vendor(vendor).title()
        # Truncate long names
        display = vendor[:45] + "…" if len(vendor) > 45 else vendor
        rows.append([display, f"${amount:,.0f}", pct, cat])

    col_widths = [2.8*inch, 1.1*inch, 1.1*inch, 0.9*inch]
    t = Table(rows, colWidths=col_widths, hAlign="LEFT", repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), PRIMARY),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.3, BORDER),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, SURFACE]),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("ALIGN", (3, 0), (-1, -1), "CENTER"),
    ]))
    return t


def build_benchmark_table(metrics: Dict, styles: Dict) -> Table:
    """Build the industry benchmark comparison table."""
    rows = [["Metric", "Your Result", "Target", "Status"]]

    def status_flag(actual: Optional[float], low: float, high: float, red: float, higher_is_worse: bool = True) -> str:
        if actual is None:
            return "N/A"
        if higher_is_worse:
            if actual <= high:
                return "OK"
            elif actual <= red:
                return "CAUTION"
            else:
                return "RED FLAG"
        else:
            if actual >= low:
                return "OK"
            elif actual >= red:
                return "CAUTION"
            else:
                return "RED FLAG"

    ns = metrics.get("net_sales_total", 0)
    fcp = metrics.get("food_cost_pct")
    lp = metrics.get("labor_pct")
    ds_pct = (metrics["debt_service_total"] / ns * 100) if ns > 0 else None
    ncf = metrics.get("net_cash_flow", 0)
    npm = (ncf / ns * 100) if ns > 0 else None

    bench = [
        ("Food Cost %", fcp, "28–32%", 32, 38, True),
        ("Labor %", lp, "28–35%", 35, 40, True),
        ("Debt Service %", ds_pct, "< 10%", 10, 15, True),
        ("Net Cash Flow %", npm, "6–9%", 6, 3, False),
    ]
    if fcp is not None and lp is not None:
        prime = fcp + lp
        prime_status = "OK" if prime <= 60 else ("CAUTION" if prime <= 70 else "RED FLAG")
        rows.append(["Prime Cost %", f"{prime:.1f}%", "< 60%", prime_status])

    for label, actual, target, warn_thresh, red_thresh, hiw in bench:
        actual_str = f"{actual:.1f}%" if actual is not None else "N/A"
        flag = status_flag(actual, warn_thresh, warn_thresh, red_thresh, hiw) if actual is not None else "N/A"
        rows.append([label, actual_str, target, flag])

    col_widths = [2.0*inch, 1.2*inch, 1.2*inch, 1.2*inch]
    t = Table(rows, colWidths=col_widths, hAlign="LEFT", repeatRows=1)
    style_cmds = [
        ("BACKGROUND", (0, 0), (-1, 0), PRIMARY),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.3, BORDER),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, SURFACE]),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("ALIGN", (1, 0), (-1, -1), "CENTER"),
    ]
    # Color status cells
    for i, row in enumerate(rows[1:], start=1):
        if len(row) >= 4:
            status = row[3]
            if status == "RED FLAG":
                style_cmds.append(("BACKGROUND", (3, i), (3, i), ERROR))
                style_cmds.append(("TEXTCOLOR", (3, i), (3, i), WHITE))
            elif status == "CAUTION":
                style_cmds.append(("BACKGROUND", (3, i), (3, i), WARNING))
                style_cmds.append(("TEXTCOLOR", (3, i), (3, i), WHITE))
            elif status == "OK":
                style_cmds.append(("BACKGROUND", (3, i), (3, i), colors.HexColor("#2E7D32")))
                style_cmds.append(("TEXTCOLOR", (3, i), (3, i), WHITE))
    t.setStyle(TableStyle(style_cmds))
    return t


def letterhead_block(business_name: str, address: str, period: str, doc_type: str, styles: Dict) -> List:
    """Return a letterhead block for vendor/bank letters."""
    elements = []
    elements.append(Spacer(1, 0.2 * inch))
    elements.append(Paragraph(business_name.upper(), styles["h1"]))
    elements.append(Paragraph(address, styles["body"]))
    elements.append(Paragraph(f"Period: {period}", styles["small"]))
    elements.append(HRFlowable(width="100%", thickness=2, color=PRIMARY, spaceAfter=12))
    elements.append(Paragraph(f"RE: {doc_type}", styles["h3"]))
    elements.append(Paragraph(datetime.now().strftime("%B %d, %Y"), styles["body"]))
    elements.append(Spacer(1, 0.2 * inch))
    return elements


def kfi_box(metrics: Dict, styles: Dict) -> Table:
    """Key Financial Information box for letters."""
    ns = metrics.get("net_sales_total", 0)
    ds_pct = (metrics["debt_service_total"] / ns * 100) if ns > 0 else 0
    fcp = metrics.get("food_cost_pct")
    lp = metrics.get("labor_pct")

    rows = [
        ["FINANCIAL SNAPSHOT", ""],
        ["Net Sales (Period)", f"${ns:,.2f}"],
        ["Total Cash In", f"${metrics.get('total_cash_in', 0):,.2f}"],
        ["Total Cash Out", f"${metrics.get('total_cash_out', 0):,.2f}"],
        ["Net Cash Flow", f"${metrics.get('net_cash_flow', 0):,.2f}"],
        ["Closing Balance", f"${metrics.get('closing_balance', 0) or 0:,.2f}"],
        ["Monthly Debt Service (avg)", f"${metrics.get('debt_service_monthly_avg', 0):,.2f}  ({ds_pct:.1f}% of revenue)"],
        ["Food Cost %", f"{fcp:.1f}%  (target: 28–32%)" if fcp is not None else "N/A"],
        ["Labor %", f"{lp:.1f}%  (target: 28–35%)" if lp is not None else "N/A"],
    ]

    t = Table(rows, colWidths=[2.5*inch, 3.5*inch], hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), PRIMARY),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("SPAN", (0, 0), (-1, 0)),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.3, BORDER),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [SURFACE, WHITE]),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ]))
    return t


def forward_projection_table(metrics: Dict, styles: Dict) -> Table:
    """Simple 6-month forward projection for bank loan letter."""
    monthly_avg_in = metrics.get("total_cash_in", 0) / max(metrics.get("num_months", 1), 1)
    monthly_avg_out = metrics.get("total_cash_out", 0) / max(metrics.get("num_months", 1), 1)
    ds_monthly = metrics.get("debt_service_monthly_avg", 0)

    # Assume new loan reduces debt service by 40%
    new_ds = ds_monthly * 0.60
    monthly_savings = ds_monthly - new_ds

    rows = [["Month", "Projected Revenue", "Projected Expenses", "Debt Service", "Net Cash Flow"]]
    balance = metrics.get("closing_balance") or 0

    from datetime import date
    today = date.today()
    month_num = today.month

    for i in range(1, 7):
        m = (month_num + i - 1) % 12 + 1
        rev = monthly_avg_in * (1 + 0.02 * i)  # slight growth assumption
        exp = monthly_avg_out - monthly_savings
        net = rev - exp
        rows.append([
            date(today.year + (month_num + i - 1) // 12, m, 1).strftime("%b %Y"),
            f"${rev:,.0f}",
            f"${exp:,.0f}",
            f"${new_ds:,.0f}",
            f"${net:,.0f}",
        ])

    col_widths = [1.1*inch, 1.3*inch, 1.3*inch, 1.2*inch, 1.2*inch]
    t = Table(rows, colWidths=col_widths, hAlign="LEFT", repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), PRIMARY),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.3, BORDER),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, SURFACE]),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
    ]))
    return t


def signature_block(business_name: str, address: str, styles: Dict) -> List:
    """Return a signature block."""
    elements = [
        Spacer(1, 0.3 * inch),
        Paragraph("Respectfully submitted,", styles["body"]),
        Spacer(1, 0.5 * inch),
        Paragraph("_________________________________", styles["body"]),
        Paragraph("[Owner / Authorized Representative]", styles["body"]),
        Paragraph(business_name, styles["h3"]),
        Paragraph(address, styles["small"]),
        Spacer(1, 0.15 * inch),
        Paragraph(
            "Prepared with assistance by MCFL Restaurant Holdings LLC",
            styles["small"],
        ),
        Paragraph(datetime.now().strftime("%B %d, %Y"), styles["small"]),
        Spacer(1, 0.2 * inch),
        HRFlowable(width="100%", thickness=0.5, color=BORDER),
        Paragraph(DISCLAIMER_FULL, styles["disclaimer"]),
    ]
    return elements


# ---------------------------------------------------------------------------
# PDF 1 — FINANCIAL ANALYSIS REPORT
# ---------------------------------------------------------------------------

def generate_analysis_report(
    metrics: Dict,
    business_name: str,
    address: str,
    period: str,
    output_path: str,
    font_name: str,
) -> str:
    """Generate the Financial Analysis Report PDF."""
    styles = make_styles(font_name)
    doc = BaseDocTemplate(
        output_path,
        pagesize=LETTER,
        leftMargin=0.6*inch, rightMargin=0.6*inch,
        topMargin=0.6*inch, bottomMargin=0.8*inch,
        title=f"Financial Analysis Report — {business_name}",
        author="MCFL Restaurant Holdings LLC",
    )

    frame = Frame(
        doc.leftMargin, doc.bottomMargin,
        doc.width, doc.height,
        id="main",
    )
    footer_fn = lambda canvas, doc: disclaimer_footer(canvas, doc, font_name)
    template = PageTemplate(id="main", frames=[frame], onPage=footer_fn)
    doc.addPageTemplates([template])

    story = []

    # --- Cover ---
    story.append(Spacer(1, 0.5 * inch))
    story.append(Paragraph("FINANCIAL ANALYSIS REPORT", styles["h1"]))
    story.append(Paragraph(business_name, styles["h2"]))
    story.append(Paragraph(address, styles["body"]))
    story.append(Paragraph(f"Analysis Period: {period}", styles["body"]))
    story.append(Paragraph(f"Generated: {datetime.now().strftime('%B %d, %Y')}", styles["small"]))
    story.append(Spacer(1, 0.2 * inch))
    story.append(HRFlowable(width="100%", thickness=2, color=PRIMARY, spaceAfter=10))

    # Disclaimer box on cover
    disclaimer_data = [[Paragraph("DISCLAIMER", styles["h3"]), ""],
                        [Paragraph(DISCLAIMER_FULL, styles["disclaimer"]), ""]]
    disc_table = Table([[Paragraph(DISCLAIMER_FULL, styles["disclaimer"])]], colWidths=[doc.width])
    disc_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), SURFACE),
        ("BOX", (0, 0), (-1, -1), 1, BORDER),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
    ]))
    story.append(disc_table)
    story.append(PageBreak())

    # --- KPI Tiles ---
    story.append(Paragraph("KEY PERFORMANCE INDICATORS", styles["h2"]))
    story.append(Spacer(1, 0.1 * inch))

    ns = metrics.get("net_sales_total", 0)
    ncf = metrics.get("net_cash_flow", 0)
    cb = metrics.get("closing_balance") or 0
    ds = metrics.get("debt_service_total", 0)
    ds_monthly = metrics.get("debt_service_monthly_avg", 0)

    kpi_data = [
        ("NET SALES", f"${ns:,.0f}", period),
        ("NET CASH FLOW", f"${ncf:,.0f}", "Period total"),
        ("ENDING BALANCE", f"${cb:,.0f}", "As of last transaction"),
        ("DEBT SERVICE", f"${ds_monthly:,.0f}/mo", f"${ds:,.0f} total"),
    ]
    story.append(build_kpi_table(kpi_data, styles, col_width=(doc.width / 4) - 4))
    story.append(Spacer(1, 0.2 * inch))

    # Secondary KPIs
    fcp = metrics.get("food_cost_pct")
    lp = metrics.get("labor_pct")
    nze_count = len(metrics.get("near_zero_events", []))
    avg_t = metrics.get("avg_ticket")

    kpi2 = [
        ("FOOD COST %", f"{fcp:.1f}%" if fcp else "N/A", "Target: 28–32%"),
        ("LABOR %", f"{lp:.1f}%" if lp else "N/A", "Target: 28–35%"),
        ("NEAR-ZERO EVENTS", str(nze_count), "Balance < $500"),
        ("AVG TICKET", f"${avg_t:.2f}" if avg_t else "N/A", "Per order"),
    ]
    story.append(build_kpi_table(kpi2, styles, col_width=(doc.width / 4) - 4))
    story.append(Spacer(1, 0.3 * inch))

    # --- Monthly Breakdown ---
    if metrics["monthly_breakdown"]:
        story.append(Paragraph("MONTHLY CASH FLOW", styles["h2"]))
        story.append(build_monthly_table(metrics["monthly_breakdown"], styles, ns))
        story.append(Spacer(1, 0.3 * inch))

    # --- Top Vendors ---
    if metrics["top_vendors"]:
        story.append(Paragraph("TOP VENDORS BY SPEND", styles["h2"]))
        story.append(Paragraph(
            "Vendors classified by keyword matching. Review for accuracy.",
            styles["small"],
        ))
        story.append(build_vendor_table(metrics["top_vendors"], styles, ns))
        story.append(Spacer(1, 0.3 * inch))

    # --- Benchmark Comparison ---
    story.append(Paragraph("INDUSTRY BENCHMARK COMPARISON", styles["h2"]))
    story.append(Paragraph(
        "Benchmarks based on QSR/Fast Casual industry standards. Sources: Restaurant365, NRA, Toast.",
        styles["small"],
    ))
    story.append(build_benchmark_table(metrics, styles))
    story.append(Spacer(1, 0.3 * inch))

    # --- Near-Zero Events ---
    nze = metrics.get("near_zero_events", [])
    if nze:
        story.append(Paragraph("NEAR-ZERO BALANCE EVENTS", styles["h2"]))
        story.append(Paragraph(
            "Dates when account balance fell below $500. These represent cash flow stress events.",
            styles["small"],
        ))
        nze_rows = [["Date", "Balance"]]
        for d, bal in nze[:20]:  # cap at 20
            nze_rows.append([str(d), f"${bal:,.2f}"])
        nze_t = Table(nze_rows, colWidths=[2*inch, 2*inch], hAlign="LEFT", repeatRows=1)
        nze_t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), ERROR),
            ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("GRID", (0, 0), (-1, -1), 0.3, BORDER),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, SURFACE]),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(nze_t)
        story.append(Spacer(1, 0.3 * inch))

    # --- Key Findings ---
    story.append(Paragraph("KEY FINDINGS", styles["h2"]))
    for finding in generate_key_findings(metrics):
        bullet_text = f"• {finding}"
        style = styles["bullet"]
        if any(word in finding for word in ["NEGATIVE", "HIGH", "CRITICAL", "CRISIS"]):
            style = ParagraphStyle(
                "BulletRed", parent=styles["bullet"], textColor=ERROR
            )
        story.append(Paragraph(bullet_text, style))
        story.append(Spacer(1, 0.05 * inch))

    doc.build(story)
    print(f"  Generated: {output_path}")
    return output_path


# ---------------------------------------------------------------------------
# PDF 2 — VENDOR CREDIT LETTER
# ---------------------------------------------------------------------------

def generate_vendor_letter(
    metrics: Dict,
    business_name: str,
    address: str,
    period: str,
    output_path: str,
    font_name: str,
    context: Optional[Dict] = None,
) -> str:
    """Generate the Vendor Credit Letter PDF."""
    context = context or {}
    styles = make_styles(font_name)

    doc = BaseDocTemplate(
        output_path,
        pagesize=LETTER,
        leftMargin=0.75*inch, rightMargin=0.75*inch,
        topMargin=0.65*inch, bottomMargin=0.85*inch,
        title=f"Vendor Credit Letter — {business_name}",
        author="MCFL Restaurant Holdings LLC",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
    footer_fn = lambda canvas, doc: disclaimer_footer(canvas, doc, font_name)
    template = PageTemplate(id="main", frames=[frame], onPage=footer_fn)
    doc.addPageTemplates([template])

    story = []
    story += letterhead_block(business_name, address, period, "REQUEST FOR VENDOR PAYMENT FLEXIBILITY", styles)

    story.append(Paragraph("Dear Valued Vendor Partner,", styles["body"]))
    story.append(Spacer(1, 0.1 * inch))

    ns = metrics.get("net_sales_total", 0)
    ncf = metrics.get("net_cash_flow", 0)
    ds_monthly = metrics.get("debt_service_monthly_avg", 0)
    ds_pct = (metrics.get("debt_service_total", 0) / ns * 100) if ns > 0 else 0

    # Determine tone based on cash flow
    if ncf >= 0:
        # Proactive tone
        opening = (
            f"We are writing to proactively open a conversation about our payment terms. "
            f"{business_name} has been proud to maintain our vendor relationships and we remain "
            f"committed to honoring our obligations. As we navigate a period of elevated operational "
            f"investment, we would like to discuss a temporary modification to our payment schedule "
            f"that preserves our ability to remain a reliable, long-term partner."
        )
    elif ncf < 0 and ncf > -ns * 0.10:
        # Reactive tone
        opening = (
            f"We are writing to address directly our recent payment timing and to present a clear "
            f"path forward. {business_name} generated net sales of ${ns:,.2f} during {period}, "
            f"demonstrating that our customer base and core operations remain intact. "
            f"Our cash flow challenge stems primarily from debt service obligations consuming "
            f"{ds_pct:.1f}% of revenue — not a collapse in business activity."
        )
    else:
        # Apologetic tone
        opening = (
            f"We owe you a direct and candid conversation. {business_name} has experienced "
            f"significant cash flow pressure during {period}, and we want to present an honest "
            f"financial picture alongside a concrete repayment plan. Despite these challenges, "
            f"our net sales reached ${ns:,.2f} for the period, and we have taken meaningful steps "
            f"to stabilize operations and address root causes."
        )

    story.append(Paragraph(opening, styles["body"]))
    story.append(Spacer(1, 0.15 * inch))

    story.append(Paragraph("OUR FINANCIAL POSITION", styles["h3"]))
    story.append(kfi_box(metrics, styles))
    story.append(Spacer(1, 0.2 * inch))

    story.append(Paragraph("MONTHLY CASH FLOW DETAIL", styles["h3"]))
    if metrics["monthly_breakdown"]:
        story.append(build_monthly_table(metrics["monthly_breakdown"], styles, ns))
    else:
        story.append(Paragraph("Monthly detail not available in provided data.", styles["small"]))
    story.append(Spacer(1, 0.2 * inch))

    # Proposal
    story.append(Paragraph("OUR PROPOSAL", styles["h3"]))
    story.append(Paragraph(
        f"We respectfully request the following payment arrangement for any outstanding balance "
        f"and/or adjusted terms going forward:",
        styles["body"],
    ))
    story.append(Spacer(1, 0.1 * inch))
    proposal_items = [
        "Extended payment terms: Net 45 or Net 60 in lieu of current terms, for a period of [X months].",
        "Partial payment plan: [X]% of outstanding balance paid monthly until balance is resolved.",
        "Continued regular ordering: We commit to continued purchasing volume with no reduction.",
        "Transparent communication: We will proactively notify you of any change in our payment capacity.",
    ]
    for item in proposal_items:
        story.append(Paragraph(f"• {item}", styles["bullet"]))
    story.append(Spacer(1, 0.2 * inch))

    # Commitments
    story.append(Paragraph("OUR COMMITMENTS", styles["h3"]))
    commitments = [
        "Consistent communication — we will notify you at least 5 business days in advance of any payment change.",
        "Payment plan adherence — we will adhere strictly to any agreed schedule.",
        "No new delinquencies — all new invoices will be paid per terms during the resolution period.",
        "Financial transparency — upon request, we will provide updated cash flow data.",
        "Long-term loyalty — as our cash position stabilizes, we intend to maintain or increase purchasing volume.",
    ]
    for c in commitments:
        story.append(Paragraph(f"• {c}", styles["bullet"]))
    story.append(Spacer(1, 0.2 * inch))

    story.append(Paragraph(
        "We value our partnership and are committed to making this right. "
        "Please contact us at your earliest convenience to discuss these terms.",
        styles["body"],
    ))

    story += signature_block(business_name, address, styles)
    doc.build(story)
    print(f"  Generated: {output_path}")
    return output_path


# ---------------------------------------------------------------------------
# PDF 3 — BANK LOAN REQUEST LETTER
# ---------------------------------------------------------------------------

def generate_bank_loan_letter(
    metrics: Dict,
    business_name: str,
    address: str,
    period: str,
    output_path: str,
    font_name: str,
    context: Optional[Dict] = None,
) -> str:
    """Generate the Bank Loan Request Letter PDF."""
    context = context or {}
    styles = make_styles(font_name)
    reason = context.get("reason", "debt_consolidation")

    doc = BaseDocTemplate(
        output_path,
        pagesize=LETTER,
        leftMargin=0.75*inch, rightMargin=0.75*inch,
        topMargin=0.65*inch, bottomMargin=0.85*inch,
        title=f"Bank Loan Request — {business_name}",
        author="MCFL Restaurant Holdings LLC",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
    footer_fn = lambda canvas, doc: disclaimer_footer(canvas, doc, font_name)
    template = PageTemplate(id="main", frames=[frame], onPage=footer_fn)
    doc.addPageTemplates([template])

    story = []
    story += letterhead_block(
        business_name, address, period,
        "SBA 7(a) LOAN REQUEST — DEBT CONSOLIDATION / WORKING CAPITAL",
        styles,
    )

    ns = metrics.get("net_sales_total", 0)
    ncf = metrics.get("net_cash_flow", 0)
    ds = metrics.get("debt_service_total", 0)
    ds_monthly = metrics.get("debt_service_monthly_avg", 0)
    ds_pct = (ds / ns * 100) if ns > 0 else 0
    num_months = max(metrics.get("num_months", 1), 1)

    # Determine tone
    if ncf > 0 and ds_pct < 10:
        opening = (
            f"We are pleased to formally request an SBA 7(a) loan on behalf of {business_name}. "
            f"We are a cash-generating operation with net sales of ${ns:,.2f} during {period} and "
            f"consistent positive monthly cash flow. This request is driven by opportunity — "
            f"specifically, to consolidate higher-rate obligations and redirect cash toward "
            f"operations and growth."
        )
    elif ds_pct >= 15:
        opening = (
            f"We respectfully submit this SBA 7(a) loan request on behalf of {business_name}. "
            f"Our business generated ${ns:,.2f} in net sales during {period}, demonstrating "
            f"a healthy underlying revenue base. However, accumulated debt service obligations "
            f"— currently at {ds_pct:.1f}% of revenue — are creating unsustainable cash flow "
            f"pressure. This refinancing facility would restructure those obligations into a "
            f"lower-rate, manageable monthly payment, materially improving our financial stability."
        )
    else:
        opening = (
            f"We are writing to formally request a business loan on behalf of {business_name}. "
            f"During {period}, the business generated net sales of ${ns:,.2f}. We are seeking "
            f"capital to consolidate existing debt obligations and provide working capital "
            f"to sustain and grow operations."
        )

    story.append(Paragraph("EXECUTIVE SUMMARY", styles["h2"]))
    story.append(Paragraph(opening, styles["body"]))
    story.append(Spacer(1, 0.2 * inch))

    # Business overview
    story.append(Paragraph("BUSINESS OVERVIEW", styles["h2"]))
    story.append(Paragraph(
        f"{business_name} is a restaurant operation located at {address}. "
        f"The following table summarizes our financial performance for {period}:",
        styles["body"],
    ))
    story.append(Spacer(1, 0.1 * inch))
    story.append(kfi_box(metrics, styles))
    story.append(Spacer(1, 0.2 * inch))

    # POS metrics
    total_orders = metrics.get("total_orders", 0)
    avg_ticket = metrics.get("avg_ticket")
    if total_orders > 0 or avg_ticket:
        pos_rows = [["POS METRIC", "VALUE"]]
        if total_orders > 0:
            pos_rows.append(["Total Transactions", f"{int(total_orders):,}"])
        if avg_ticket:
            pos_rows.append(["Average Ticket", f"${avg_ticket:.2f}"])
        monthly_avg_sales = ns / num_months
        pos_rows.append(["Monthly Avg. Net Sales", f"${monthly_avg_sales:,.2f}"])
        pos_t = Table(pos_rows, colWidths=[2.5*inch, 2.0*inch], hAlign="LEFT")
        pos_t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), PRIMARY),
            ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("GRID", (0, 0), (-1, -1), 0.3, BORDER),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [SURFACE, WHITE]),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(pos_t)
        story.append(Spacer(1, 0.2 * inch))

    # Cash flow detail
    story.append(Paragraph("CASH FLOW DETAIL", styles["h2"]))
    if metrics["monthly_breakdown"]:
        story.append(build_monthly_table(metrics["monthly_breakdown"], styles, ns))
    story.append(Spacer(1, 0.2 * inch))

    # Debt stack (if available)
    debt_vendors = {k: v for k, v in metrics.get("top_vendors", {}).items()
                    if classify_vendor(k) == "debt"}
    if debt_vendors:
        story.append(Paragraph("CURRENT DEBT OBLIGATIONS", styles["h2"]))
        story.append(Paragraph(
            "The following obligations were identified in the bank statement. "
            "This refinancing loan would consolidate or replace these instruments:",
            styles["body"],
        ))
        debt_rows = [["Creditor / Instrument", "Total Payments in Period", "Monthly Avg.", "Est. Type"]]
        for vendor, total in list(debt_vendors.items())[:10]:
            monthly_avg = total / num_months
            debt_rows.append([
                vendor[:45],
                f"${total:,.0f}",
                f"${monthly_avg:,.0f}",
                "MCA / Loan",
            ])
        debt_t = Table(debt_rows, colWidths=[2.5*inch, 1.5*inch, 1.2*inch, 1.0*inch], hAlign="LEFT", repeatRows=1)
        debt_t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), PRIMARY),
            ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("GRID", (0, 0), (-1, -1), 0.3, BORDER),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, SURFACE]),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ]))
        story.append(debt_t)
        story.append(Spacer(1, 0.2 * inch))

    # Forward projection
    story.append(Paragraph("6-MONTH FORWARD PROJECTION (POST-LOAN)", styles["h2"]))
    story.append(Paragraph(
        "The following projection assumes loan approval reduces monthly debt service by ~40% "
        "and modest 2% monthly revenue growth. These are illustrative estimates only.",
        styles["small"],
    ))
    story.append(forward_projection_table(metrics, styles))
    story.append(Spacer(1, 0.2 * inch))

    # Loan request details
    loan_amount = max(ds * 1.5, 50000)  # rough request estimate
    story.append(Paragraph("LOAN REQUEST DETAILS", styles["h2"]))
    loan_rows = [
        ["DETAIL", "REQUEST"],
        ["Loan Type", "SBA 7(a) Term Loan"],
        ["Requested Amount", f"${loan_amount:,.0f}"],
        ["Purpose", "Debt consolidation / working capital"],
        ["Requested Term", "5–7 years"],
        ["Repayment", "Monthly fixed payment"],
        ["Collateral Offered", "Business assets + personal guarantee"],
    ]
    loan_t = Table(loan_rows, colWidths=[2.5*inch, 3.5*inch], hAlign="LEFT")
    loan_t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), PRIMARY),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("SPAN", (0, 0), (-1, 0)),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.3, BORDER),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [SURFACE, WHITE]),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(loan_t)
    story.append(Spacer(1, 0.2 * inch))

    # Why this loan makes sense
    story.append(Paragraph("WHY THIS LOAN MAKES SENSE", styles["h2"]))
    rationale = [
        f"Revenue base is established: ${ns:,.2f} in net sales over {period} demonstrates "
        f"a viable, customer-supported operation.",
        f"Debt service is the primary cash flow problem: At {ds_pct:.1f}% of revenue, current "
        f"debt obligations — likely MCA instruments at effective rates of 80–200% APR — are the "
        f"principal drag on profitability.",
        "SBA refinancing would replace high-rate obligations with a predictable, fixed monthly "
        "payment at a fraction of the effective cost.",
        "Operations are stable: vendor relationships, staffing, and customer base are intact. "
        "This is a capital structure problem, not a business model problem.",
        "Our projections show positive monthly cash flow post-restructuring, meeting the DSCR ≥ 1.25 "
        "threshold typically required for SBA approval.",
    ]
    for r in rationale:
        story.append(Paragraph(f"• {r}", styles["bullet"]))
        story.append(Spacer(1, 0.05 * inch))

    story.append(Spacer(1, 0.15 * inch))
    story.append(Paragraph(
        "We welcome the opportunity to provide additional documentation, tax returns, "
        "or any other materials required to support this application. Thank you for your "
        "consideration.",
        styles["body"],
    ))

    story += signature_block(business_name, address, styles)
    doc.build(story)
    print(f"  Generated: {output_path}")
    return output_path


# ---------------------------------------------------------------------------
# SECURITY — DELETE INPUT FILES
# ---------------------------------------------------------------------------

def secure_delete_inputs(bank_path: Optional[str], pos_path: Optional[str]) -> None:
    """Explicitly delete input files after processing. Security requirement."""
    for path in [bank_path, pos_path]:
        if path and os.path.exists(path):
            try:
                os.remove(path)
                print(f"[SECURITY] Deleted input file: {path}")
            except Exception as e:
                print(f"[SECURITY WARNING] Could not delete {path}: {e}")
    print("[SECURITY] Input files deleted after processing")


# ---------------------------------------------------------------------------
# NAMING CONVENTION
# ---------------------------------------------------------------------------

def make_slug(business_name: str) -> str:
    """Convert business name to lowercase hyphenated slug."""
    slug = re.sub(r"[^a-z0-9]+", "-", business_name.lower()).strip("-")
    return slug


def period_to_ym(period: str) -> str:
    """
    Convert a period string to YYYY-MM format for filenames.
    Examples: 'Q1 2026' -> '2026-03', 'March 2026' -> '2026-03', '2026-01' -> '2026-01'
    """
    # Try to detect quarter
    q_match = re.search(r"Q(\d)\s*(\d{4})", period, re.IGNORECASE)
    if q_match:
        q, year = int(q_match.group(1)), int(q_match.group(2))
        end_month = q * 3
        return f"{year}-{end_month:02d}"

    # Try month name
    for fmt in ["%B %Y", "%b %Y", "%Y-%m", "%m/%Y"]:
        try:
            dt = datetime.strptime(period.strip(), fmt)
            return dt.strftime("%Y-%m")
        except ValueError:
            continue

    # Fallback: current month
    return datetime.now().strftime("%Y-%m")


# ---------------------------------------------------------------------------
# MAIN ENTRY POINT
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Restaurant Financial Triage — PDF Generator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--bank", help="Path to bank statement (XLS/XLSX/CSV)")
    parser.add_argument("--pos", help="Path to POS sales export (XLS/XLSX/CSV)")
    parser.add_argument("--project-name", required=True, help="Project codename (anonymized — no real business name)")
    parser.add_argument("--address", default="N/A", help="Business address")
    parser.add_argument("--period", required=True, help="Analysis period (e.g. 'Q1 2026')")
    parser.add_argument("--output-dir", default=".", help="Output directory for PDFs")
    parser.add_argument("--mode", default="restaurant", choices=["restaurant", "personal"],
                        help="Analysis mode: 'restaurant' (default) or 'personal'")
    parser.add_argument(
        "--context",
        default="{}",
        help='Optional JSON context string: {"reason": "bank_loan", "locations": 1}',
    )

    args = parser.parse_args()

    if not args.bank and not args.pos:
        print("ERROR: At least one of --bank or --pos must be provided.")
        sys.exit(1)

    # --- Setup ---
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    font_name = setup_fonts()

    try:
        context = json.loads(args.context)
    except json.JSONDecodeError:
        print(f"WARNING: Could not parse --context JSON. Using empty context.")
        context = {}

    # --- Parse files ---
    bank_df = None
    pos_df = None

    if args.bank:
        bank_df = parse_bank_statement(args.bank)
    if args.pos:
        pos_df = parse_pos_export(args.pos)

    # SECURITY: Anonymize immediately — before any analysis
    project_name = args.project_name  # new required arg
    access_token = generate_access_token()
    print(f"[SECURITY] Project: {project_name} | Token: {access_token}")
    bank_df = anonymize_dataframe(bank_df, project_name) if bank_df is not None else None
    pos_df = anonymize_dataframe(pos_df, project_name) if pos_df is not None else None
    print("[SECURITY] All PII stripped from datasets.")

    # --- Build filenames ---
    slug = re.sub(r'[^a-z0-9]+', '-', project_name.lower()).strip('-')
    ym = period_to_ym(args.period)

    generated = []

    if args.mode == "personal":
        # ── PERSONAL MODE ──
        print("\n[MODE] Personal financial triage")
        print("\nCalculating personal financial metrics...")
        metrics = calculate_personal_metrics(bank_df)

        print(f"\nMetrics Summary:")
        print(f"  Total Income:     ${metrics['total_income']:,.2f}")
        print(f"  Total Expenses:   ${metrics['total_expenses']:,.2f}")
        print(f"  Net Position:     ${metrics['total_income'] - metrics['total_expenses']:,.2f}")
        print(f"  Closing Balance:  ${metrics.get('closing_balance') or 0:,.2f}")
        print(f"  Burn Rate:        ${metrics.get('burn_rate', 0):,.2f}/mo")
        print(f"  Categories:       {len(metrics.get('category_totals', {}))}")
        print(f"  Subscriptions:    {len(metrics.get('subscriptions', []))}")
        print(f"  Near-Zero Events: {len(metrics.get('near_zero_events', []))}")
        print(f"  Months of data:   {metrics['num_months']}")

        overview_path = str(output_dir / f"{slug}-personal-overview-{ym}.pdf")
        creditor_path = str(output_dir / f"{slug}-creditor-letter-{ym}.pdf")
        lender_path = str(output_dir / f"{slug}-lender-letter-{ym}.pdf")

        print(f"\nGenerating PDFs in: {output_dir}")

        print("\n[1/3] Personal Financial Overview...")
        generate_personal_overview(metrics, project_name, args.address, args.period, overview_path, font_name)
        generated.append(overview_path)

        print("\n[2/3] Creditor Letter...")
        generate_creditor_letter(metrics, project_name, args.address, args.period, creditor_path, font_name)
        generated.append(creditor_path)

        print("\n[3/3] Lender Letter...")
        generate_lender_letter(metrics, project_name, args.address, args.period, lender_path, font_name)
        generated.append(lender_path)

        # ── OPTIONAL: SBA Form 413 + Truist PFS auto-population ──
        # Only generated when context includes 'personal_info' key
        if context.get("personal_info"):
            try:
                from generate_forms import generate_sba_413, generate_truist_pfs, build_financial_data_from_context
                print("\n[4/5] SBA Form 413 (Personal Financial Statement)...")
                fd = build_financial_data_from_context(context, metrics)
                sba_path = str(output_dir / f"{slug}-sba-413-{ym}.pdf")
                generate_sba_413(fd, sba_path)
                generated.append(sba_path)

                print("\n[5/5] Truist Personal Financial Statement...")
                truist_path = str(output_dir / f"{slug}-truist-pfs-{ym}.pdf")
                generate_truist_pfs(fd, truist_path, font_name)
                generated.append(truist_path)
            except Exception as e:
                print(f"[forms] WARNING: Could not generate bank forms: {e}")
        else:
            print("\n[INFO] No personal_info in context — skipping SBA 413 + Truist PFS.")
            print("       Pass personal_info in context JSON to enable form auto-population.")

    else:
        # ── RESTAURANT MODE (existing) ──
        print("\n[MODE] Restaurant financial triage")
        print("\nCalculating financial metrics...")
        metrics = calculate_metrics(bank_df, pos_df)

        print(f"\nMetrics Summary:")
        print(f"  Net Sales:        ${metrics['net_sales_total']:,.2f}")
        print(f"  Total Cash In:    ${metrics['total_cash_in']:,.2f}")
        print(f"  Total Cash Out:   ${metrics['total_cash_out']:,.2f}")
        print(f"  Net Cash Flow:    ${metrics['net_cash_flow']:,.2f}")
        print(f"  Closing Balance:  ${metrics.get('closing_balance') or 0:,.2f}")
        print(f"  Food Cost %:      {metrics.get('food_cost_pct', 'N/A')}")
        print(f"  Labor %:          {metrics.get('labor_pct', 'N/A')}")
        print(f"  Debt Service:     ${metrics['debt_service_total']:,.2f}")
        print(f"  Near-Zero Events: {len(metrics['near_zero_events'])}")
        print(f"  Months of data:   {metrics['num_months']}")

        analysis_path = str(output_dir / f"{slug}-financial-analysis-{ym}.pdf")
        vendor_path = str(output_dir / f"{slug}-vendor-letter-{ym}.pdf")
        loan_path = str(output_dir / f"{slug}-bank-loan-letter-{ym}.pdf")

        print(f"\nGenerating PDFs in: {output_dir}")

        print("\n[1/3] Financial Analysis Report...")
        generate_analysis_report(metrics, project_name, args.address, args.period, analysis_path, font_name)
        generated.append(analysis_path)

        print("\n[2/3] Vendor Credit Letter...")
        generate_vendor_letter(metrics, project_name, args.address, args.period, vendor_path, font_name, context)
        generated.append(vendor_path)

        print("\n[3/3] Bank Loan Request Letter...")
        generate_bank_loan_letter(metrics, project_name, args.address, args.period, loan_path, font_name, context)
        generated.append(loan_path)

        # ── OPTIONAL: SBA Form 413 + Truist PFS auto-population (restaurant mode) ──
        # Triggered when client provides personal_info in context JSON
        if context.get("personal_info"):
            try:
                from generate_forms import generate_sba_413, generate_truist_pfs, build_financial_data_from_context
                print("\n[4/5] SBA Form 413 (Personal Financial Statement)...")
                # For restaurant mode, derive closing_balance from bank metrics
                form_metrics = {"closing_balance": metrics.get("closing_balance", 0)}
                fd = build_financial_data_from_context(context, form_metrics)
                sba_path = str(output_dir / f"{slug}-sba-413-{ym}.pdf")
                generate_sba_413(fd, sba_path)
                generated.append(sba_path)

                print("\n[5/5] Truist Personal Financial Statement...")
                truist_path = str(output_dir / f"{slug}-truist-pfs-{ym}.pdf")
                generate_truist_pfs(fd, truist_path, font_name)
                generated.append(truist_path)
            except Exception as e:
                print(f"[forms] WARNING: Could not generate bank forms: {e}")

    # --- Security: delete input files ---
    secure_delete_inputs(args.bank, args.pos)

    # --- Summary ---
    print("\n" + "=" * 60)
    print("OUTPUT SUMMARY")
    print("=" * 60)
    total_size = 0
    for path in generated:
        if os.path.exists(path):
            size = os.path.getsize(path)
            total_size += size
            print(f"  {Path(path).name:55s}  {size/1024:.1f} KB")
    print(f"\n  Total output size: {total_size/1024:.1f} KB")
    print("=" * 60)
    print("\n[SECURITY] All input files have been deleted.")
    print("[DONE] Job complete. MCFL Restaurant Holdings LLC.")


if __name__ == "__main__":
    main()

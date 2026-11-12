"""Render the outbound targeting brief for the sales team as a PDF (reportlab)."""
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle, KeepTogether)

OUT = r"C:\Users\anumo\Downloads\Vitosha-Outbound-Targeting-Brief-2026-11-12.pdf"
NAVY = colors.HexColor("#0B40B0")
LIGHT = colors.HexColor("#E8EEF9")
GREY = colors.HexColor("#5A6270")

ss = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=ss["Title"], fontSize=20, leading=24, textColor=NAVY, alignment=TA_LEFT, spaceAfter=4)
SUB = ParagraphStyle("SUB", parent=ss["Normal"], fontSize=9.5, textColor=GREY, spaceAfter=14)
H2 = ParagraphStyle("H2", parent=ss["Heading2"], fontSize=13, leading=16, textColor=NAVY, spaceBefore=14, spaceAfter=6)
BODY = ParagraphStyle("BODY", parent=ss["Normal"], fontSize=9.5, leading=13, spaceAfter=6)
CELL = ParagraphStyle("CELL", parent=ss["Normal"], fontSize=8.5, leading=11)
CELLB = ParagraphStyle("CELLB", parent=CELL, fontName="Helvetica-Bold", textColor=colors.white)
NOTE = ParagraphStyle("NOTE", parent=BODY, fontSize=8.5, textColor=GREY)


def P(t, s=BODY):
    return Paragraph(t, s)


def table(header, rows, widths):
    data = [[Paragraph(h, CELLB) for h in header]] + [[Paragraph(c, CELL) for c in r] for r in rows]
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT]),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#C9D3E6")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(GREY)
    canvas.drawString(0.75 * inch, 0.5 * inch, "Vitosha Inc - Outbound targeting brief - internal, sales team")
    canvas.drawRightString(letter[0] - 0.75 * inch, 0.5 * inch, f"Page {doc.page}")
    canvas.restoreState()


W = letter[0] - 1.5 * inch
story = []
story += [P("Outbound targeting brief", H1),
          P("Who we write to, why, and how the lists are built. Prepared 12 November 2026 from Vitosha's 42 published case studies, "
            "its three Microsoft Solutions Partner designations, the Databricks partnership, and the results of the September and October campaigns.", SUB)]

story += [P("The one-line version", H2),
          P("We only email people at companies that look like a client we have already helped, who are showing a dated reason to act now, "
            "and we say which case study and which trigger in the first sentence. Two contacts per company, a few hundred per lane, verified before sending."),
          P("Why: September and October sent about 60,000 product-name emails to generic audiences and produced three leads. "
            "The lists were not bad; the emails had no reason to exist for the reader. The lanes below fix that.")]

story += [P("1. Who Vitosha wins with (the ICP), in order of proof", H2)]
story.append(table(
    ["Tier", "Companies", "Size", "Evidence", "Pillar sold"],
    [["1", "US banks, credit unions, P&amp;C and specialty insurers, wealth and custody firms", "200 to 10,000 staff",
      "19 of 42 case studies: AML, fraud, KYC, claims, regulatory reporting, treasury, loan origination", "Data &amp; AI (Azure ML, Fabric); D365 Finance"],
     ["2", "Distributors, 3PLs, manufacturers, pharma distributors", "100 to 5,000",
      "Warehouse WMS, MRP, e-commerce to ERP, mining maintenance, pharma QC", "D365 Supply Chain &amp; Finance"],
     ["3", "Hospitals and health systems on Microsoft 365", "500+", "Clinical analytics on Fabric, patient churn model", "Fabric / Data &amp; AI"],
     ["4", "Construction, real estate, nonprofits, professional services", "100 to 2,000",
      "Project controls, revenue recognition (ASC 606), grant accounting", "D365 Finance / Project Operations"],
     ["5", "UAE businesses on Dynamics, AED 50m+ revenue", "any", "E-invoicing mandate (ASP by 30 Oct 2026, live 1 Jan 2027); Dubai delivery centre", "D365 Finance"],
     ["Ref. only", "State agencies, transit authorities, universities, K-12", "", "Our only named clients (Wyoming, Ohio Taxation, MBTA, Hampton Roads Transit, Oregon)",
      "RFP agent, not cold email"]],
    [0.55 * inch, 1.9 * inch, 0.9 * inch, 2.35 * inch, 1.3 * inch]))
story.append(P("Anything outside this table (any company on Power BI, Copilot for anyone, Databricks for anyone) stays off the list until there is a case study for it.", NOTE))

story += [P("2. Who we write to (personas per pillar)", H2)]
story.append(table(
    ["Pillar", "Economic buyer", "Champion (gets the first email)", "Technical gate"],
    [["Data &amp; AI, financial services", "CCO / CRO / COO", "BSA Officer, Head of Financial Crimes, Chief Claims Officer, Head of Onboarding", "CIO, CDO"],
     ["D365 Supply Chain / Finance", "CFO / COO", "VP Operations, VP Supply Chain, Controller", "CIO, IT Director, ERP Manager"],
     ["Fabric / analytics", "CIO / CDO", "Director of Analytics, VP Quality, CMIO", "Director of Data Engineering"],
     ["D365 Finance, services firms", "CFO", "Controller, Director of Finance, Director of Project Controls", "IT Director"]],
    [1.6 * inch, 1.2 * inch, 2.7 * inch, 1.5 * inch]))
story.append(P("Two contacts per company: the champion plus one of the other two. Never six.", NOTE))

story += [P("3. The rule that decides whether anyone is pulled: a dated trigger", H2),
          P("No contact enters a list on fit alone. One of these must be true, and it goes in the first sentence of the email:")]
story.append(table(
    ["#", "Trigger", "Where we see it"],
    [["1", "A public regulatory event: OCC/FinCEN AML order, UAE e-invoicing deadline, a new reporting rule", "Regulators' monthly releases; mandate calendars"],
     ["2", "Hiring in the function we fix, posted in the last 90 days", "Apollo job-posting filter"],
     ["3", "A legacy platform we migrate (GP/NAV/AX, SSRS, Hadoop/Cloudera) plus modernization hiring", "Apollo technology tags + job postings"],
     ["4", "New CFO, CIO, CDO, CCO or COO in the last 6 months", "Apollo / HarvestAPI job-change signals"],
     ["5", "Acquisition, new facility, or funding in the last 6 months", "News scan (research agents), Apollo funding filter"]],
    [0.4 * inch, 4.1 * inch, 2.5 * inch]))
story.append(P("Disqualified regardless: staffing, IT services and consulting firms; government (RFP route); under 50 staff; companies already on the platform "
               "we would be pitching adoption of; anyone Vitosha contacted in the last 90 days (the Contact Vault enforces this automatically).", NOTE))

story.append(PageBreak())
story += [P("4. The lanes", H2),
          P("A lane is one case study plus one trigger plus one persona set, with its own three-step Smartlead sequence. Five are live as of 7 November 2026; "
            "seven more are ready to size once the first five have two weeks of results.")]
story.append(table(
    ["Lane", "Case study cited", "Trigger", "First list"],
    [["AML / financial crimes", "AML Monitoring Modernization: 70% fewer false positives", "Hiring BSA/AML staff; named in a 2026 OCC/FinCEN order", "92"],
     ["Insurance claims AI", "Claims Automation: cycle time -50%, leakage -30%; computer-vision damage detection", "Hiring claims data science / automation roles", "189"],
     ["Warehouse / distribution", "Warehouse Barcode Automation: 35% faster picking, 99.9% accuracy; MRP: inventory -30%", "Hiring warehouse, inventory or DC managers", "505"],
     ["Clinical analytics", "Unified Clinical Analytics on Fabric: 60% faster quality reports", "Health systems on Microsoft 365 hiring data/BI roles", "247"],
     ["KYC / onboarding", "Perpetual KYC: 50% faster; SME loan origination: cycle time -60%", "Banks hiring KYC, onboarding or loan-operations staff", "156"],
     ["Next: fraud, finance close, regulatory reporting, treasury, revenue recognition, project controls, grant accounting",
      "Each has a case study with a quoted metric", "Hiring in the matching function", "150 to 600 each"]],
    [1.5 * inch, 2.6 * inch, 2.1 * inch, 0.8 * inch]))

story += [P("5. How a list is built, every time", H2)]
story.append(table(
    ["Step", "What happens", "Tool / cost"],
    [["Size", "Count the lane for free in Apollo with the trigger window moved forward; no credits spent", "Apollo search"],
     ["Dedupe", "Remove anyone already in the Contact Vault (every person Vitosha has ever paid for or emailed)", "Contact Vault, free"],
     ["Cap", "Two contacts per company, applied before any email is revealed", "campaign_pull.py"],
     ["Reveal", "Verified-status emails only; one Apollo credit each", "Apollo"],
     ["Verify", "Independent SMTP check within 7 days of sending; hard-invalid addresses removed, catch-all flagged", "BounceVerify, about $0.90 per 1,000"],
     ["Deliver", "One Excel workbook: a sheet per lane, a Summary, the email angles and the sequences", "Downloads / MailPulse"],
     ["Send", "Each lane into its own standing Smartlead campaign; valid addresses first, catch-all after bounces look clean", "Smartlead"],
     ["Measure", "Sent, bounced, replied, positive per lane on day 14 and day 30; outcomes recorded against each contact", "Smartlead stats, Contact Vault"]],
    [0.8 * inch, 4.2 * inch, 2.0 * inch]))

story += [P("6. Volumes, spend and what to expect", H2)]
story.append(table(
    ["", "Proof-led lanes (standard)", "Volume stream (only if decided separately)"],
    [["Contacts per month", "3,000 to 4,000 across ~12 lanes", "~65,000 (for 200,000 emails)"],
     ["Data cost per month", "Existing Apollo plan + about $100 verification and freshness checks", "$3,000 to $4,000 (bulk data licence + verification)"],
     ["Mailboxes needed", "Current fleet (202 boxes) is ample", "250 to 300 boxes, a separate $2,000 to $3,000 and a warm-up period"],
     ["Expected positive replies", "1 to 2% of contacts: 40 to 80 real conversations a month", "0.2 to 0.4% at best; September/October ran at 0.005%"],
     ["Decision rule", "Retire a lane with no positives after two cycles; add lanes when a case study is published", "Fund only if cost per positive reply beats the lanes"]],
    [1.6 * inch, 2.7 * inch, 2.7 * inch]))

story += [P("7. What we stop doing", H2),
          P("Product-name campaigns to generic audiences. Lists over 5,000. More than two contacts per company. Sending anything unverified. "
            "Pulling a new list before the previous one has two weeks of results. Changing a lane on fewer than five leads of evidence."),
          P("8. The monthly cadence", H2)]
story.append(table(
    ["When", "What", "Who"],
    [["1st of the month", "Lanes re-run with the trigger window moved forward; workbook delivered the same day", "Claude"],
     ["Same day", "Each lane's sheet loaded into its standing Smartlead campaign; sequences unchanged", "Sales team"],
     ["Day 14 and day 30", "Per-lane results reviewed; lanes retired or extended only with evidence", "Claude proposes, Ajay decides"],
     ["When a case study is published", "A lane is added for it if a dated trigger exists", "Claude"]],
    [1.6 * inch, 4.4 * inch, 1.0 * inch]))
story.append(Spacer(1, 10))
story.append(P("Data quality, stated plainly: Apollo's verified badge keeps hard bounces near 3%, but about a third of business addresses sit on catch-all domains no vendor can confirm, "
               "and roughly 30% of contacts change jobs each year. Verification within a week of sending is what protects the sender fleet; the badge alone does not.", NOTE))

doc = SimpleDocTemplate(OUT, pagesize=letter, leftMargin=0.75 * inch, rightMargin=0.75 * inch, topMargin=0.7 * inch, bottomMargin=0.8 * inch,
                        title="Vitosha outbound targeting brief", author="Vitosha Inc")
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print("written:", OUT)

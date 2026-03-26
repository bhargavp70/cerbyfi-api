"""SMTP email sender. Configure via environment variables in Railway."""
import smtplib
import logging
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from app.config import settings

logger = logging.getLogger(__name__)


def send_verification_email(to_email: str, name: str, verify_url: str) -> bool:
    """Send account verification email. Returns True on success."""
    if not settings.smtp_host or not settings.smtp_user or not settings.smtp_pass:
        logger.warning("SMTP not configured — skipping verification email.")
        return False

    html = f"""
    <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0a0a14;color:#f0f0fa;">
      <div style="margin-bottom:24px;">
        <span style="font-size:1.4rem;font-weight:900;">Cerby<span style="color:#4f8ef7;">Fi</span></span>
      </div>
      <h2 style="font-size:1.2rem;font-weight:700;margin-bottom:12px;">Verify your email address</h2>
      <p style="color:#9999bb;line-height:1.6;margin-bottom:28px;">
        Hi {name},<br><br>
        Thanks for creating a CerbyFi account. Click the button below to verify your
        email address. This link expires in <strong style="color:#f0f0fa;">24 hours</strong>.
      </p>
      <a href="{verify_url}"
         style="display:inline-block;padding:12px 28px;background:#4f8ef7;color:#fff;
                border-radius:8px;text-decoration:none;font-weight:700;font-size:0.95rem;">
        Verify Email Address
      </a>
      <p style="margin-top:28px;font-size:0.8rem;color:#5a5a80;">
        If you didn't create this account you can ignore this email.<br>
        Or copy this link: <a href="{verify_url}" style="color:#4f8ef7;">{verify_url}</a>
      </p>
    </div>
    """

    msg = MIMEMultipart("alternative")
    msg["Subject"] = "Verify your CerbyFi email address"
    msg["From"]    = settings.smtp_from or settings.smtp_user
    msg["To"]      = to_email
    msg.attach(MIMEText(html, "html"))

    try:
        port = int(settings.smtp_port)
        if port == 465:
            with smtplib.SMTP_SSL(settings.smtp_host, port, timeout=10) as server:
                server.login(settings.smtp_user, settings.smtp_pass)
                server.sendmail(msg["From"], [to_email], msg.as_string())
        else:
            with smtplib.SMTP(settings.smtp_host, port, timeout=10) as server:
                server.ehlo()
                server.starttls()
                server.login(settings.smtp_user, settings.smtp_pass)
                server.sendmail(msg["From"], [to_email], msg.as_string())
        logger.info("Verification email sent to %s", to_email)
        return True
    except Exception as e:
        logger.error("Failed to send verification email: %s", e)
        return False

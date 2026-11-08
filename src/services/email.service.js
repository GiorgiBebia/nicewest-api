import dotenv from "dotenv";

dotenv.config();

// ელფოსტის გაგზავნა Brevo-ს HTTP API-ით (SMTP პორტები Render-ის უფასო გეგმაზე დაბლოკილია).
// Render-ში საჭირო ცვლადები:
//   BREVO_API_KEY  - Brevo-ს API key
//   MAIL_FROM      - დადასტურებული გამგზავნი მისამართი (მაგ. nicewestsupport@gmail.com)
//   MAIL_FROM_NAME - სურვილისამებრ, ნაგულისხმევი "NiceWest"
const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const SEND_TIMEOUT_MS = 10000;

export const isEmailConfigured = () => Boolean(process.env.BREVO_API_KEY && process.env.MAIL_FROM);

export const sendEmail = async ({ to, subject, html, text }) => {
  if (!isEmailConfigured()) {
    throw new Error("EMAIL_NOT_CONFIGURED: BREVO_API_KEY ან MAIL_FROM არ არის განსაზღვრული");
  }

  const res = await fetch(BREVO_URL, {
    method: "POST",
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: { name: process.env.MAIL_FROM_NAME || "NiceWest", email: process.env.MAIL_FROM },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`BREVO ${res.status}: ${body.slice(0, 300)}`);
  }
};

const TEMPLATES = {
  register: {
    subject: "NiceWest: ელფოსტის დადასტურება",
    intro: "რეგისტრაციის დასასრულებლად შეიყვანეთ ეს კოდი აპლიკაციაში:",
  },
  reset_password: {
    subject: "NiceWest: პაროლის აღდგენა",
    intro: "პაროლის აღსადგენად შეიყვანეთ ეს კოდი აპლიკაციაში:",
  },
};

// code არის მხოლოდ 6 ციფრი (სერვერი თვითონ აგენერირებს), ამიტომ HTML-ში ჩასმა უსაფრთხოა
export const sendCodeEmail = async ({ to, code, purpose, ttlMinutes }) => {
  const tpl = TEMPLATES[purpose];
  if (!tpl) throw new Error(`Unknown email purpose: ${purpose}`);

  const footer = `კოდი მოქმედებს ${ttlMinutes} წუთის განმავლობაში. თუ ეს თქვენ არ მოგითხოვიათ, უბრალოდ უგულებელყავით ეს წერილი.`;

  const html = `<!doctype html>
<html lang="ka">
  <body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:420px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;">
      <h2 style="margin:0 0 16px;color:#0f172a;">NiceWest</h2>
      <p style="margin:0 0 20px;color:#334155;font-size:15px;">${tpl.intro}</p>
      <div style="font-size:34px;letter-spacing:8px;font-weight:bold;text-align:center;color:#0f172a;background:#f1f5f9;border-radius:10px;padding:16px 0;">${code}</div>
      <p style="margin:20px 0 0;color:#64748b;font-size:13px;">${footer}</p>
    </div>
  </body>
</html>`;

  const text = `${tpl.intro}\n\n${code}\n\n${footer}`;

  await sendEmail({ to, subject: tpl.subject, html, text });
};

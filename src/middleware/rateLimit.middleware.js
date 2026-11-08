import rateLimit from "express-rate-limit";

const make = (windowMs, limit, message, keyGenerator) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { message },
    ...(keyGenerator ? { keyGenerator } : {}),
  });

// ყველა მოთხოვნაზე ზოგადი ლიმიტი (IP-ზე)
export const globalLimiter = make(60 * 1000, 300, "ძალიან ბევრი მოთხოვნა. სცადეთ ცოტა ხანში.");

// შესვლა: IP-ზე 20 მცდელობა 15 წუთში
export const loginIpLimiter = make(15 * 60 * 1000, 20, "ძალიან ბევრი შესვლის მცდელობა. სცადეთ 15 წუთის შემდეგ.");

// შესვლა: ერთ username-ზე 10 მცდელობა 15 წუთში (პაროლის გამოცნობისგან დაცვა)
export const loginUserLimiter = make(
  15 * 60 * 1000,
  10,
  "ამ ანგარიშზე ძალიან ბევრი მცდელობა. სცადეთ 15 წუთის შემდეგ.",
  (req) =>
    `u:${String(req.body?.username || "")
      .toLowerCase()
      .trim()}`,
);

// რეგისტრაცია და social-login: IP-ზე 10 საათში
export const registerLimiter = make(60 * 60 * 1000, 10, "ძალიან ბევრი რეგისტრაციის მცდელობა. სცადეთ მოგვიანებით.");

// ელფოსტის კოდის გაგზავნა (ხელახლა გაგზავნა, პაროლის აღდგენა): IP-ზე 15 საათში
export const emailCodeIpLimiter = make(60 * 60 * 1000, 15, "ძალიან ბევრი კოდის მოთხოვნა. სცადეთ მოგვიანებით.");

// იგივე ელფოსტაზე: 5 წერილი საათში (სხვისი ელფოსტის დაბომბვისგან დაცვა)
const emailKey = (req) =>
  `e:${String(req.body?.email || "")
    .toLowerCase()
    .trim()}`;

export const emailCodeAddressLimiter = make(
  60 * 60 * 1000,
  5,
  "ამ ელფოსტაზე ძალიან ბევრი კოდი გაიგზავნა. სცადეთ მოგვიანებით.",
  emailKey,
);

// ჩვეულებრივი რეგისტრაცია იგზავნის წერილს; Google-ით რეგისტრაციას (email-ის გარეშე) ეს ლიმიტი არ ეხება
export const registerEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "ამ ელფოსტაზე ძალიან ბევრი კოდი გაიგზავნა. სცადეთ მოგვიანებით." },
  keyGenerator: emailKey,
  skip: (req) => !req.body?.email,
});

// კოდის შემოწმება (რეგისტრაციის დადასტურება, პაროლის შეცვლა): IP-ზე 30 მცდელობა 15 წუთში.
// თითო კოდზე ცალკე ლიმიტია ბაზაში (5 არასწორი მცდელობა).
export const codeVerifyLimiter = make(15 * 60 * 1000, 30, "ძალიან ბევრი მცდელობა. სცადეთ 15 წუთის შემდეგ.");

// შეტყობინებების გაგზავნა: მომხმარებელზე წუთში 30
export const messageLimiter = make(
  60 * 1000,
  30,
  "შეტყობინებებს ძალიან სწრაფად აგზავნით.",
  (req) => `m:${req.user?.id ?? "anon"}`,
);

// ფოტოს ატვირთვის ბილეთები: მომხმარებელზე 30 10 წუთში
export const uploadLimiter = make(
  10 * 60 * 1000,
  30,
  "ფოტოებს ძალიან ხშირად ტვირთავთ. სცადეთ მოგვიანებით.",
  (req) => `up:${req.user?.id ?? "anon"}`,
);

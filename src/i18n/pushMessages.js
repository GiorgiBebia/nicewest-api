// Push შეტყობინებების ტექსტები მომხმარებლის ენის მიხედვით (users.language: 'ka' | 'en').
// ახალი ენის დასამატებლად საკმარისია აქ ახალი ბლოკის დამატება.

export const DEFAULT_LANG = "ka";

export const normalizeLang = (value) => {
  const v = String(value || "").toLowerCase();
  return v.startsWith("en") ? "en" : DEFAULT_LANG;
};

export const PUSH_MESSAGES = {
  ka: {
    likes_reset: {
      title: "მოწონებები განახლდა! 🎉",
      body: "შენი {{count}} დღიური მოწონება კვლავ აქტიურია. დაბრუნდი აპლიკაციაში!",
    },
    match: {
      title: "ახალი Match! 🎉",
      body: "შენ და {{name}} მოეწონეთ ერთმანეთი! დაწერე პირველმა 💬",
    },
    chat_message: {
      title: "ახალი შეტყობინება: {{name}}",
      body: "{{text}}",
    },
    profile_approved: {
      title: "პროფილი დადასტურებულია! 🎉",
      body: "თქვენი განაცხადი წარმატებით დამოწმდა. ახლა შეგიძლიათ ისარგებლოთ აპლიკაციით.",
    },
    profile_rejected: {
      title: "პროფილის განაცხადი უარყოფილია ⚠️",
      body: "თქვენს პროფილში დაფიქსირდა ხარვეზი. გთხოვთ შეამოწმოთ დეტალები და განაახლოთ პროფილი.",
    },
    match_reminder: {
      title: "⏳ Match-ს დრო ეწურება",
      body: "{{name}}-თან Match-ის ვადა დაახლოებით {{hours}} საათში იწურება. დაწერე პირველმა!",
    },
    match_expired: {
      title: "Match-ის ვადა გავიდა",
      body: "{{name}}-თან Match-ს ვადა გაუვიდა, რადგან მიმოწერა არ დაწყებულა.",
    },
    likes_digest_one: {
      title: "შენ ვიღაცას მოეწონე 💕",
      body: "1 ადამიანს მოსწონხარ. გახსენი აპლიკაცია და გაიგე ვინ არის!",
    },
    likes_digest_other: {
      title: "{{count}} ადამიანს მოსწონხარ 💕",
      body: "გახსენი აპლიკაცია და გაიგე ვინ არიან!",
    },
  },
  en: {
    likes_reset: {
      title: "Your likes are back! 🎉",
      body: "Your {{count}} daily likes are active again. Come back to the app!",
    },
    match: {
      title: "New match! 🎉",
      body: "You and {{name}} liked each other! Say hi first 💬",
    },
    chat_message: {
      title: "New message: {{name}}",
      body: "{{text}}",
    },
    profile_approved: {
      title: "Your profile is approved! 🎉",
      body: "Your profile has been verified. You can now use the app.",
    },
    profile_rejected: {
      title: "Your profile was rejected ⚠️",
      body: "We found a problem in your profile. Please check the details and update it.",
    },
    match_reminder: {
      title: "⏳ Your match is running out of time",
      body: "Your match with {{name}} expires in about {{hours}} hours. Send the first message!",
    },
    match_expired: {
      title: "Match expired",
      body: "Your match with {{name}} has expired because no conversation was started.",
    },
    likes_digest_one: {
      title: "Someone likes you 💕",
      body: "1 person likes you. Open the app to see who!",
    },
    likes_digest_other: {
      title: "{{count}} people like you 💕",
      body: "Open the app to see who!",
    },
  },
};

const fill = (template, params) =>
  String(template).replace(/\{\{(\w+)\}\}/g, (_, k) =>
    params[k] !== undefined && params[k] !== null ? String(params[k]) : "",
  );

// key + ენა + პარამეტრები -> { title, body }
export const renderPush = (key, lang, params = {}) => {
  const dict =
    PUSH_MESSAGES[normalizeLang(lang)] || PUSH_MESSAGES[DEFAULT_LANG];
  let msg = dict[key] || PUSH_MESSAGES[DEFAULT_LANG][key];

  // მხოლობითი/მრავლობითის ვარიანტები: key_one / key_other
  if (!msg && dict[`${key}_one`]) {
    msg =
      Number(params.count) === 1 ? dict[`${key}_one`] : dict[`${key}_other`];
  }
  if (!msg) return null;
  return { title: fill(msg.title, params), body: fill(msg.body, params) };
};

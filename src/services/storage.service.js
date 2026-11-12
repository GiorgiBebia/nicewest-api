import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

export const PHOTO_BUCKET = "profile-photos";

let client = null;

// service_role / secret key მხოლოდ სერვერზეა (Render env). აპში არასდროს უნდა მოხვდეს.
const getClient = () => {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "SUPABASE_URL ან SUPABASE_SERVICE_ROLE_KEY არ არის დაყენებული",
      );
    }
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
};

// ერთჯერადი ატვირთვის ბილეთი კონკრეტულ ფაილზე: {userId}/{დრო}_{ინდექსი}_{random}.{ext}
export const createPhotoUploadTarget = async (userId, index, ext) => {
  const path = `${userId}/${Date.now()}_${index}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
  const bucket = getClient().storage.from(PHOTO_BUCKET);

  const { data, error } = await bucket.createSignedUploadUrl(path);
  if (error) throw error;

  const { data: pub } = bucket.getPublicUrl(path);
  return { path: data.path, token: data.token, publicUrl: pub.publicUrl };
};

// ფოტოს URL უნდა იყოს ჩვენი bucket-ის და სწორედ ამ მომხმარებლის საქაღალდის
export const isOwnPhotoUrl = (value, userId) => {
  const base = process.env.SUPABASE_URL;
  if (!base || typeof value !== "string" || value.length > 1000) return false;
  const prefix = `${base.replace(/\/+$/, "")}/storage/v1/object/public/${PHOTO_BUCKET}/${userId}/`;
  return value.startsWith(prefix) && !value.includes("..");
};

const DELETED_FOLDER = "deleted";

// public URL -> ბაკეტის შიდა გზა ({userId}/{ფაილი}); სხვის ან უცხო URL-ს აბრუნებს null-ს
const pathFromPhotoUrl = (url, userId) => {
  const base = process.env.SUPABASE_URL;
  if (!base || typeof url !== "string") return null;
  const prefix = `${base.replace(/\/+$/, "")}/storage/v1/object/public/${PHOTO_BUCKET}/`;
  if (!url.startsWith(prefix)) return null;
  const path = decodeURIComponent(url.slice(prefix.length).split("?")[0]);
  if (path.includes("..") || !path.startsWith(`${userId}/`)) return null;
  return path;
};

// წაშლილი ფოტოების გადატანა: {userId}/{ფაილი} -> deleted/{userId}/{ფაილი}
// ფაილს არ ვშლით, მხოლოდ ვცვლით მისამართს. შეცდომა არასდროს აგდებს მოთხოვნას (best-effort).
export const moveUserPhotosToDeleted = async (userId, urls) => {
  try {
    const paths = [
      ...new Set(
        (urls || []).map((u) => pathFromPhotoUrl(u, userId)).filter(Boolean),
      ),
    ];
    if (paths.length === 0) return;
    const bucket = getClient().storage.from(PHOTO_BUCKET);
    for (const path of paths) {
      const { error } = await bucket.move(path, `${DELETED_FOLDER}/${path}`);
      if (error)
        console.error("MOVE PHOTO TO DELETED ERROR:", path, error.message);
    }
  } catch (err) {
    console.error("MOVE PHOTOS TO DELETED ERROR:", err);
  }
};

// უარყოფილი ფოტოების არქივი: ფაილს ვაკოპირებთ deleted/{userId}/rejected/{ფაილი}-ში,
// ორიგინალი კი თავის ადგილას რჩება, რომ მომხმარებელმა settings-ში თავისი "დრაფტი" დაინახოს.
// (როცა ფოტოს შეცვლის, updateProfile ორიგინალს ჩვეულებრივ deleted/-ში გადაიტანს.) best-effort.
export const archiveRejectedPhotos = async (userId, urls) => {
  try {
    const paths = [
      ...new Set(
        (urls || []).map((u) => pathFromPhotoUrl(u, userId)).filter(Boolean),
      ),
    ];
    if (paths.length === 0) return;
    const bucket = getClient().storage.from(PHOTO_BUCKET);
    for (const path of paths) {
      const file = path.split("/").pop();
      const target = `${DELETED_FOLDER}/${userId}/rejected/${Date.now()}_${file}`;
      const { error } = await bucket.copy(path, target);
      if (error)
        console.error("ARCHIVE REJECTED PHOTO ERROR:", path, error.message);
    }
  } catch (err) {
    console.error("ARCHIVE REJECTED PHOTOS ERROR:", err);
  }
};

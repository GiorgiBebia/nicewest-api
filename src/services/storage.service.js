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
      throw new Error("SUPABASE_URL ან SUPABASE_SERVICE_ROLE_KEY არ არის დაყენებული");
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

// Twice a day (15:00 and 20:00, Zagreb time) the owner gets a notification: the post for the WhatsApp group is ready.
// WhatsApp lets no app post into an ordinary group by itself, so the game prepares the picture and the text (?digest=1)
// and the owner shares them with two taps. Runs every 30 minutes; each slot is sent once a day.
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { sendTo } from "./push.mts";
import { MASTER } from "./roles.mts";

export const SLOTS = [15 * 60, 20 * 60]; // minutes after midnight, Zagreb
const GAME = "https://zmijica.onrender.com/";
export function slotNow(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zagreb", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
  const min = Number(p.hour) * 60 + Number(p.minute), day = `${p.year}-${p.month}-${p.day}`;
  const slot = SLOTS.find((s) => min >= s && min < s + 30); // the run within half an hour after the slot
  return slot == null ? null : { day, slot };
}
export async function run(now = new Date()) {
  const s = slotNow(now); if (!s) return "idle";
  const store = getStore({ name: "vijuga-digest", consistency: "strong" }), key = `${s.day}/${s.slot}`;
  if (await store.get(key)) return "already";
  await store.setJSON(key, { at: Date.now() });
  const evening = s.slot >= 18 * 60;
  const n = await sendTo(MASTER, { title: evening ? "📣 Večernja objava za Vijugicu" : "📣 Objava za Vijugicu", body: "Slika i tekst s novostima su spremni: dodirni, pa Podijeli i odaberi grupu.", url: GAME + "?digest=1", tag: "digest" }).catch(() => 0);
  return `sent ${n}`;
}
export default async () => new Response(await run());
export const config: Config = { schedule: "*/30 * * * *" };

// Every 5 minutes: 15 minutes before a voted "when do we meet" hour, remind everyone who voted for it.
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { sendTo } from "./push.mts";

const zone = (t: number) => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zagreb", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(t));
  const g = (k: string) => f.find((p) => p.type === k)?.value || "00";
  return { day: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) % 24, minute: Number(g("minute")) };
};

export default async () => {
  const soon = zone(Date.now() + 15 * 60000), now = zone(Date.now());
  // the hour that starts within the next 15 minutes
  if (soon.hour === now.hour) return new Response("nothing due");
  const hour = soon.hour, day = soon.day;
  const meet = getStore({ name: "vijuga-meet", consistency: "strong" });
  const push = getStore({ name: "vijuga-push", consistency: "strong" });
  const mark = `sent/${day}/${hour}`;
  if (await push.get(mark)) return new Response("already sent");
  const { blobs } = await meet.list({ prefix: day + "/" });
  const votes = ((await Promise.all(blobs.map((b) => meet.get(b.key, { type: "json" })))) as { slug: string; name: string; slots: number[] }[]).filter((v) => v && Array.isArray(v.slots) && v.slots.includes(hour));
  await push.set(mark, String(Date.now()));
  if (votes.length < 2) return new Response("not enough voters");
  const names = votes.map((v) => v.name).join(", ");
  let sent = 0;
  for (const v of votes) sent += await sendTo(v.slug, { title: `⏰ Vijuga u ${hour}:00!`, body: `Uskoro igramo (u ${hour}:00). Dolaze: ${names}. Dodirni da uđeš.`, url: "https://zmijica.onrender.com/", tag: `meet-${day}-${hour}` });
  return new Response(`sent ${sent} to ${votes.length} voters`);
};

export const config: Config = { schedule: "*/5 * * * *" };

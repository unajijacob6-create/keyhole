// npm run gen:images — generate the website's illustrations with FLUX.2 on NEAR AI Cloud, then
// encode them as WebP at web-friendly sizes into web/public/img/. Re-runnable; prompts are kept
// here so the images are reproducible in spirit (diffusion output is not bit-for-bit deterministic).
//   npx tsx scripts/gen-images.ts [name …]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BASE = process.env.NEARAI_CLOUD_BASE_URL ?? "https://cloud-api.near.ai";
const KEY = process.env.NEARAI_CLOUD_API_KEY ?? "proxy-injected";
const MODEL = "black-forest-labs/FLUX.2-klein-4B";
const STYLE =
  "soft premium 3D render, pastel lavender and periwinkle palette, misty pale lilac atmosphere, soft diffused studio light, shallow depth of field, calm modern fintech aesthetic, highly detailed, no text, no letters, no logos";

export const IMAGES: Record<string, { prompt: string; size: string; widths: number[] }> = {
  hero: {
    prompt: `A soft rolling hill covered in violet and lilac wildflowers with a few dry golden grass tips, occupying only the bottom quarter of the frame, seen from a low eye-level camera. Above it, a completely empty smooth pale lilac sky with soft haze. Nothing else in the image. Wide composition. ${STYLE}`,
    size: "1536x1024",
    widths: [1600, 960],
  },
  key: {
    prompt: `A single tall purple coneflower (echinacea) on a thin stem rising from a small mound of violet wildflowers, and a polished lavender-silver antique key leaning against it, placed on the right side of the frame; the left side is an empty smooth pale lavender gradient background. ${STYLE}`,
    size: "1536x1024",
    widths: [960, 640],
  },
  vault: {
    prompt: `A round lavender metal vault door, slightly open, set into a soft hill covered in violet and lilac wildflowers, glowing soft light from the gap, centered composition, empty pale lilac sky above. ${STYLE}`,
    size: "1536x1024",
    widths: [1200, 720],
  },
  pavilion: {
    prompt: `A small classical lavender marble pavilion with columns and a triangular pediment, standing on a mound of violet and lilac flowers on the right side of the frame, empty pale lavender sky on the left. ${STYLE}`,
    size: "1536x1024",
    widths: [1200, 720],
  },
  glow: {
    prompt: `A glowing translucent lavender glass keyhole shape floating above a few dark violet flowers, deep midnight navy background with a soft violet glow, minimal, centered. soft premium 3D render, deep indigo and lavender palette, no text, no letters, no logos`,
    size: "1024x1024",
    widths: [720, 480],
  },
};

const OUT = path.resolve("web/public/img");
const RAW = path.resolve("scratch/img");
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(RAW, { recursive: true });

async function gen(name: string) {
  const spec = IMAGES[name];
  const r = await fetch(`${BASE}/v1/images/generations`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt: spec.prompt, n: 1, size: spec.size, response_format: "b64_json" }),
  });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const d: any = await r.json();
  const raw = path.join(RAW, `${name}.jpg`);
  fs.writeFileSync(raw, Buffer.from(d.data[0].b64_json, "base64"));
  for (const w of spec.widths) {
    execFileSync("python3", ["-c", `from PIL import Image; im=Image.open(${JSON.stringify(raw)}).convert("RGB"); h=round(im.height*${w}/im.width); im.resize((${w},h), Image.LANCZOS).save(${JSON.stringify(path.join(OUT, `${name}-${w}.webp`))}, "WEBP", quality=80, method=6)`]);
  }
  console.log(`${name}: ${spec.widths.map((w) => `${name}-${w}.webp (${(fs.statSync(path.join(OUT, `${name}-${w}.webp`)).size / 1024).toFixed(0)} KB)`).join(", ")}`);
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(IMAGES);
await Promise.all(names.map((n) => gen(n).catch((e) => console.error(String(e)))));

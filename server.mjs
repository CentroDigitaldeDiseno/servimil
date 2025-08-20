import express from "express";
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";

const app = express();
app.use(express.json({ limit: "25mb" }));

// Config Gemini
const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error("Falta GEMINI_API_KEY");
const ai = new GoogleGenAI({ apiKey });

// Utilidades
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tmp = (name) => path.join("/tmp", name || crypto.randomUUID());

// Descarga el audio desde una URL (añade header si es un enlace de WhatsApp Cloud API)
async function downloadAudio(url) {
  const headers = {};
  if (/graph\.facebook\.com|lookaside\.fbcdn\.net|\.fbsbx\.com/.test(url)) {
    if (!process.env.META_WA_TOKEN) {
      throw new Error("El audio requiere token de WhatsApp. Define META_WA_TOKEN en Render.");
    }
    headers.Authorization = `Bearer ${process.env.META_WA_TOKEN}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`No se pudo descargar audio: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = (res.headers.get("content-type") || "").toLowerCase(); // p.ej. 'audio/ogg; codecs=opus'
  return { buf, contentType: ct.split(";")[0] || "audio/ogg" };
}

// Transcodifica siempre a WAV mono/16k para máxima compatibilidad
async function toWav16k(inputBuf) {
  const inFile = tmp("in.ogg");
  const outFile = tmp("out.wav");
  await fs.writeFile(inFile, inputBuf);
  ffmpeg.setFfmpegPath(ffmpegPath);
  await new Promise((resolve, reject) => {
    ffmpeg(inFile)
      .audioChannels(1)
      .audioFrequency(16000)
      .format("wav")
      .output(outFile)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
  const wav = await fs.readFile(outFile);
  await fs.unlink(inFile).catch(()=>{});
  await fs.unlink(outFile).catch(()=>{});
  return wav;
}

// Endpoint para Manychat
app.post("/transcribe", async (req, res) => {
  try {
    const { audio_url, language, prompt } = req.body || {};
    if (!audio_url) {
      return res.status(400).json({ error: "Falta audio_url en el body" });
    }

    // 1) Descarga
    const { buf } = await downloadAudio(audio_url);

    // 2) Transcodifica a WAV 16 kHz mono (rápido para notas de voz)
    const wav = await toWav16k(buf);
    const base64 = wav.toString("base64");

    // 3) Llama a Gemini (modelo rápido con audio)
    const model = "gemini-2.5-flash"; // admite comprensión de audio
    const sys = [
      "Eres un transcriptor fiable.",
      "Regresa SOLO la transcripción del audio, sin notas ni formato extra.",
      language ? `Idioma principal esperado: ${language}` : null,
      prompt ? `Instrucción adicional: ${prompt}` : null
    ].filter(Boolean).join("\n");

    const result = await ai.models.generateContent({
      model,
      contents: [
        { role: "user", parts: [{ text: sys }] },
        { role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: base64 } }] }
      ]
    });

    const transcript = result?.response?.text?.() || result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!transcript) throw new Error("Gemini no devolvió texto");

    // Devuelve algo fácil de mapear en Manychat
    res.json({
      ok: true,
      transcript,
      reply: transcript // puedes post-procesar si quieres
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Healthcheck para Render
app.get("/healthz", (_req, res) => res.send("ok"));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Listening on :${port}`));

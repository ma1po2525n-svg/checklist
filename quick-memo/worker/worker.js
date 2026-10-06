// Cloudflare Worker: スマホのメモ → Notion DB にページ追加する中継
//   POST /       PWA(index.html)からの送信。ヘッダ x-passcode で認証
//   POST /line   LINE Messaging API の Webhook。X-Line-Signature で認証
//
// Secrets: NOTION_TOKEN, DATABASE_ID, APP_SECRET, LINE_CHANNEL_SECRET, LINE_CHANNEL_TOKEN, LINE_USER_ID
// 任意(vars): TITLE_PROP(既定 "Name"), TAG_PROP(複数選択の列名。未設定ならタグ無視), ALLOWED_ORIGIN(既定 *)

const NOTION_VERSION = "2022-06-28";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/line") return handleLine(req, env);
    return handleApp(req, env);
  },
};

// ---------- Notion ----------
async function createNote(env, text, tags = []) {
  // 1行目 = タイトル、残り = 本文
  const [first, ...rest] = text.split("\n");
  const title = first.slice(0, 200);
  const bodyText = rest.join("\n").trim();

  const properties = {
    [env.TITLE_PROP || "Name"]: { title: [{ text: { content: title } }] },
  };
  if (env.TAG_PROP && tags.length) {
    properties[env.TAG_PROP] = {
      multi_select: tags.slice(0, 10).map((name) => ({ name: String(name).slice(0, 100) })),
    };
  }

  // rich_text は1ブロック2000字まで
  const children = [];
  for (let i = 0; i < bodyText.length && children.length < 90; i += 2000) {
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ text: { content: bodyText.slice(i, i + 2000) } }] },
    });
  }

  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({ parent: { database_id: env.DATABASE_ID }, properties, children }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || "notion error");
  }
  return { id: (await res.json()).id, title };
}

// ---------- PWA ----------
async function handleApp(req, env) {
  const cors = {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Headers": "content-type, x-passcode",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json" } });

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!env.APP_SECRET || req.headers.get("x-passcode") !== env.APP_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const text = String(body.text || "").trim();
  if (!text) return json({ error: "empty" }, 400);

  try {
    const { id } = await createNote(env, text, Array.isArray(body.tags) ? body.tags : []);
    return json({ ok: true, id });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

// ---------- LINE ----------
async function verifyLineSignature(secret, rawBody, signature) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, rawBody);
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  // 定数時間比較
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function lineReply(env, replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: text.slice(0, 5000) }] }),
  });
}

// 「#仕事 #買い物」のような #タグ を抜き出し、本文からは取り除く
function extractTags(text) {
  const tags = [];
  const cleaned = text
    .replace(/(^|\s)#([^\s#]+)/g, (_, sp, tag) => {
      tags.push(tag);
      return sp;
    })
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return { text: cleaned, tags };
}

async function handleLine(req, env) {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const raw = await req.arrayBuffer();
  if (!(await verifyLineSignature(env.LINE_CHANNEL_SECRET, raw, req.headers.get("x-line-signature")))) {
    return new Response("unauthorized", { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  for (const ev of payload.events || []) {
    if (ev.type !== "message" || !ev.replyToken) continue;
    const userId = ev.source?.userId;

    // 初回セットアップ用: LINE_USER_ID が未設定なら ID を返信して終了
    if (!env.LINE_USER_ID) {
      await lineReply(env, ev.replyToken, `あなたのユーザーID:\n${userId}\n\nこれを LINE_USER_ID に設定してください。`);
      continue;
    }
    if (userId !== env.LINE_USER_ID) continue; // 他人のメッセージは無視

    if (ev.message?.type !== "text") {
      await lineReply(env, ev.replyToken, "テキストのみ対応しています。");
      continue;
    }

    const { text, tags } = extractTags(ev.message.text.trim());
    if (!text) {
      await lineReply(env, ev.replyToken, "本文が空です。");
      continue;
    }
    try {
      const { title } = await createNote(env, text, tags);
      await lineReply(env, ev.replyToken, `✅ 保存しました\n${title}${tags.length ? `\n🏷 ${tags.join(", ")}` : ""}`);
    } catch (e) {
      await lineReply(env, ev.replyToken, `⚠️ 保存に失敗しました: ${e.message}`);
    }
  }
  return new Response("ok");
}

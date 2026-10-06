// Cloudflare Worker: スマホのメモ入力 → Notion DB にページ追加する中継
// 環境変数(Secrets): NOTION_TOKEN, DATABASE_ID, APP_SECRET
// 任意: TITLE_PROP(既定 "Name"), TAG_PROP(複数選択プロパティ名。未設定ならタグ無視), ALLOWED_ORIGIN(既定 *)

const NOTION_VERSION = "2022-06-28";

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Headers": "content-type, x-passcode",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, "content-type": "application/json" },
      });

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

    // 1行目 = タイトル、残り = 本文
    const [first, ...rest] = text.split("\n");
    const title = first.slice(0, 200);
    const bodyText = rest.join("\n").trim();

    const properties = {
      [env.TITLE_PROP || "Name"]: { title: [{ text: { content: title } }] },
    };
    if (env.TAG_PROP && Array.isArray(body.tags) && body.tags.length) {
      properties[env.TAG_PROP] = {
        multi_select: body.tags.slice(0, 10).map((name) => ({ name: String(name).slice(0, 100) })),
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
      body: JSON.stringify({
        parent: { database_id: env.DATABASE_ID },
        properties,
        children,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return json({ error: err.message || "notion error" }, 502);
    }
    const page = await res.json();
    return json({ ok: true, id: page.id });
  },
};

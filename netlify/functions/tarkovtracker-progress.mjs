// RaidPlan -> TarkovTracker read-progress proxy.
// The user's token is used only for this request. It is not logged or persisted here.

const UPSTREAM = "https://api.tarkovtracker.org/progress";

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function validToken(token) {
  return /^(PVP_|PVE_|SZN_)[A-Za-z0-9_-]{8,}$/.test(String(token || "").trim());
}

export default async (req) => {
  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405, { allow: "POST" });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: "Invalid JSON request" }, 400);
  }

  const token = String(body?.token || "").trim();
  if (!validToken(token)) {
    return json({ success: false, error: "Invalid TarkovTracker Progress API token format" }, 400);
  }

  try {
    const upstream = await fetch(UPSTREAM, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": "RaidPlan/1.6 (+https://tarkovraidplan.netlify.app)",
      },
    });

    let payload = {};
    try {
      payload = await upstream.json();
    } catch {
      payload = {};
    }

    if (!upstream.ok) {
      const raw = String(payload?.error || payload?.statusMessage || "");
      const error =
        upstream.status === 401 ? "TarkovTracker rejected this token. Check that it is an active PVP_, PVE_ or SZN_ Progress API token." :
        upstream.status === 403 ? "This TarkovTracker token does not have permission to read progress." :
        upstream.status === 429 ? "TarkovTracker rate limit reached. Try again later." :
        raw || `TarkovTracker returned ${upstream.status}.`;
      return json({ success: false, error }, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
    }

    const data = payload?.data || {};
    const meta = payload?.meta || {};
    const tasksProgress = Array.isArray(data?.tasksProgress)
      ? data.tasksProgress.map((t) => ({
          id: String(t?.id || ""),
          complete: t?.complete === true,
          failed: t?.failed === true,
          invalid: t?.invalid === true,
        })).filter((t) => t.id)
      : [];

    return json({
      success: true,
      data: {
        displayName: data?.displayName ?? "",
        playerLevel: Number(data?.playerLevel) || 0,
        pmcFaction: data?.pmcFaction ?? "",
        gameEdition: data?.gameEdition ?? null,
        tasksProgress,
      },
      meta: {
        gameMode: meta?.gameMode ?? data?.gameMode ?? "",
      },
    });
  } catch {
    return json({ success: false, error: "Unable to reach TarkovTracker right now." }, 502);
  }
};

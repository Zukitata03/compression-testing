const $ = (id) => document.getElementById(id);
let assets = [];
let activeId = null;
let activeTier = "original";

let viewerSig = null;

async function refresh() {
  const res = await fetch("/api/assets");
  assets = await res.json();
  renderList();
  if (activeId) {
    const current = assets.find((a) => a.id === activeId);
    if (current) {
      // Rebuilding the viewer kills the playing video / reloads the PDF embed.
      // Only re-render when the manifest actually changed; a 15s poll of an
      // untouched asset must not touch the DOM the media lives in.
      const sig = JSON.stringify([current.status, current.progress, current.variants, current.error]);
      if (sig !== viewerSig) {
        viewerSig = sig;
        renderViewer(current);
      }
    } else {
      activeId = null;
      viewerSig = null;
    }
  }
  const anyProcessing = assets.some((a) => a.status === "processing" || a.status === "uploaded");
  scheduleNext(anyProcessing ? 3000 : 15000);
}

function scheduleNext(ms) {
  clearTimeout(scheduleNext.t);
  scheduleNext.t = setTimeout(refresh, ms);
}

function fmtBytes(n) {
  if (n > 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n > 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n > 1e3) return (n / 1e3).toFixed(1) + " KB";
  return n + " B";
}

function renderList() {
  const list = $("list");
  list.textContent = "";
  for (const a of assets) {
    const row = document.createElement("div");
    row.className = "row" + (a.id === activeId ? " active" : "");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = a.originalName;
    const meta = document.createElement("div");
    meta.className = "meta";
    const chip = document.createElement("span");
    chip.className = "chip " + a.status;
    chip.textContent = a.status === "processing" && a.progress
      ? `tier ${a.progress.tier}/${a.progress.total}`
      : a.status;
    meta.append(chip, " " + fmtBytes(a.originalBytes));
    row.append(name, meta);
    row.onclick = () => { activeId = a.id; activeTier = "original"; viewerSig = null; renderList(); renderViewer(a); };
    list.append(row);
  }
}

function renderViewer(asset) {
  const stats = $("stats");
  const viewer = $("viewer");

  if (asset.status !== "ready") {
    viewerSig = JSON.stringify([asset.status, asset.progress, [], asset.error]);
    viewer.textContent = asset.status === "failed"
      ? "Failed: " + (asset.error ?? "unknown error")
      : "Processing" + (asset.progress ? ` (tier ${asset.progress.tier}/${asset.progress.total})` : "…");
    stats.textContent = "";
    return;
  }
  const variants = asset.variants ?? [];
  viewerSig = JSON.stringify([asset.status, asset.progress, asset.variants, asset.error]);

  // Documents preview the PDF tier; their original is a binary container.
  if (asset.kind === "document" && activeTier === "original" && variants.some((v) => v.mimeType === "application/pdf")) {
    activeTier = "screen";
  }
  const hasHls = asset.kind === "video" && variants.some((v) => v.mimeType === "application/vnd.apple.mpegurl");
  const url = `/api/assets/${asset.id}/files/${activeTier}`;
  const mime = (variants.find((v) => v.label === activeTier) ?? variants[0]).mimeType;
  viewer.textContent = "";
  if (hasHls) {
    buildVideoPlayer(viewer, `/api/assets/${asset.id}/master.m3u8`, asset, true);
  } else if (mime.startsWith("video/")) {
    buildVideoPlayer(viewer, url, asset, false);
  } else if (mime.startsWith("image/")) {
    const player = document.createElement("div");
    player.id = "player";
    const img = document.createElement("img");
    img.src = url;
    player.append(img);
    viewer.append(player);
  } else if (mime.startsWith("audio/")) {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = url;
    viewer.append(audio);
  } else if (mime === "application/pdf") {
    const player = document.createElement("div");
    player.id = "player";
    player.classList.add("embed-box");
    const embed = document.createElement("embed");
    embed.src = url;
    embed.type = "application/pdf";
    player.append(embed);
    viewer.append(player);
  } else {
    fetch(url).then((r) => r.text()).then((t) => {
      const pre = document.createElement("pre");
      if (asset.kind === "text" && (asset.mimeType === "application/json")) {
        pre.textContent = JSON.stringify(JSON.parse(t), null, 2);
      } else {
        pre.textContent = t.slice(0, 2000000);
      }
      viewer.append(pre);
    });
  }

  stats.textContent = variants.map((v) => {
    const saving = 100 - Math.round((v.sizeBytes / asset.originalBytes) * 100);
    return `${v.label}: ${fmtBytes(v.sizeBytes)} (−${saving}%)`;
  }).join("   ");
}
// ---- custom video player ----

function buildVideoPlayer(viewer, url, asset, useHls) {
  const player = document.createElement("div");
  player.id = "player";
  const video = document.createElement("video");
  player.append(video);
  let hls = null;
  const variants = asset.variants ?? [];
  if (useHls && window.Hls && Hls.isSupported()) {
    hls = new Hls({ maxBufferLength: 30, startLevel: -1 });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (useHls && video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
  } else {
    video.src = url;
  }

  const controls = document.createElement("div");
  controls.id = "controls";
  const playBtn = document.createElement("button");
  playBtn.textContent = "▶";
  const seek = document.createElement("div");
  seek.id = "seek";
  const seekFill = document.createElement("div");
  seekFill.id = "seekfill";
  seek.append(seekFill);
  const time = document.createElement("span");
  time.id = "time";
  const settings = document.createElement("div");
  settings.id = "settings";
  const gear = document.createElement("button");
  gear.textContent = "⚙";
  const menu = document.createElement("div");
  menu.id = "qualityMenu";
  settings.append(gear, menu);
  controls.append(playBtn, seek, time, settings);
  player.append(controls);
  viewer.append(player);

  if (hls) {
    // Tier items resolve their level index when the manifest has been parsed.
    const auto = document.createElement("div");
    auto.dataset.tier = "auto";
    auto.textContent = "Auto";
    auto.onclick = () => { hls.currentLevel = -1; markActive(); menu.classList.remove("show"); };
    menu.append(auto);
    for (const v of variants.filter((v) => v.mimeType === "application/vnd.apple.mpegurl")) {
      const item = document.createElement("div");
      item.dataset.tier = v.label;
      item.textContent = v.label;
      item.onclick = () => {
        const idx = hls.levels.findIndex((l) => Math.abs(l.height - parseInt(item.dataset.tier, 10)) <= 4);
        if (idx < 0) { menu.classList.remove("show"); return; }
        // hls.js plays out the old level's buffer before switching; on short
        // clips the whole file fits in the buffer, so force a re-append by
        // nudging currentTime after the pin (YouTube flushes the same way).
        const t = video.currentTime;
        hls.currentLevel = idx;
        video.currentTime = t;
        markActive();
        menu.classList.remove("show");
      };
      menu.append(item);
    }
    function markActive() {
      const active = hls.autoLevelEnabled ? "auto" : String(hls.levels[hls.currentLevel]?.height ?? "") + "p";
      for (const item of menu.children) {
        item.classList.toggle("active", item.dataset.tier === active);
      }
    }
    hls.on(Hls.Events.LEVEL_SWITCHED, markActive);
    hls.on(Hls.Events.MANIFEST_PARSED, markActive);
  } else {
    for (const v of variants.filter((v) => v.mimeType === "video/mp4" || v.mimeType === "application/vnd.apple.mpegurl")) {
      const item = document.createElement("div");
      item.dataset.label = v.label;
      item.textContent = v.label === "original" ? `${v.label} (source)` : v.label;
      item.onclick = () => {
        if (item.dataset.label === activeTier) { menu.classList.remove("show"); return; }
        const t = video.currentTime;
        const wasPlaying = !video.paused;
        activeTier = item.dataset.label;
        renderViewer(asset);
        const nv = $("viewer").querySelector("video");
        if (nv) {
          const seekBack = () => { nv.currentTime = t; if (wasPlaying) nv.play(); };
          if (nv.readyState >= 1) seekBack();
          else nv.addEventListener("loadedmetadata", seekBack, { once: true });
        }
      };
      menu.append(item);
    }
    for (const item of menu.children) {
      if (item.dataset.label === activeTier) item.classList.add("active");
    }
  }

  gear.onclick = (e) => { e.stopPropagation(); menu.classList.toggle("show"); };
  document.addEventListener("click", () => menu.classList.remove("show"), { once: true });

  playBtn.onclick = () => { video.paused ? video.play() : video.pause(); };
  video.onplay = () => { playBtn.textContent = "⏸"; };
  video.onpause = () => { playBtn.textContent = "▶"; };
  video.ontimeupdate = () => {
    if (video.duration) seekFill.style.width = (video.currentTime / video.duration) * 100 + "%";
    time.textContent = fmtTime(video.currentTime) + " / " + fmtTime(video.duration);
  };
  seek.onclick = (e) => {
    const rect = seek.getBoundingClientRect();
    video.currentTime = ((e.clientX - rect.left) / rect.width) * video.duration;
  };
  return player;
}

function fmtTime(s) {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return m + ":" + sec;
}



$("drop").onclick = () => $("file").click();
$("file").onchange = async () => {
  const file = $("file").files[0];
  if (!file) return;
  const body = new FormData();
  body.append("file", file);

  const box = $("upprogress");
  $("upname").textContent = file.name;
  $("upfill").style.width = "0";
  $("uppct").textContent = "0%";
  box.hidden = false;

  // XHR instead of fetch: fetch has no upload progress events.
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/assets");
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    $("upfill").style.width = pct + "%";
    $("uppct").textContent = `${pct}%  (${fmtBytes(e.loaded)} / ${fmtBytes(e.total)})`;
  };
  xhr.onload = () => {
    box.hidden = true;
    $("file").value = "";
    refresh();
    if (xhr.status !== 201) alert("Upload failed: " + xhr.status);
  };
  xhr.onerror = () => { box.hidden = true; alert("Upload failed: network error"); };
  xhr.send(body);
};
refresh();

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
const themePicker = document.querySelector("#theme");
const deviceTheme = window.matchMedia?.("(prefers-color-scheme: dark)");
const themeStorageKey = "play-my-list.theme";
let themePreference = "auto";
try {
  const saved = localStorage.getItem(themeStorageKey);
  if (["auto", "light", "dark"].includes(saved)) themePreference = saved;
} catch {
  // Storage may be unavailable in a private or embedded webview.
}
function applyTheme() {
  const telegramTheme = tg?.colorScheme;
  const automatic = ["light", "dark"].includes(telegramTheme)
    ? telegramTheme
    : deviceTheme?.matches
      ? "dark"
      : "light";
  const theme = themePreference === "auto" ? automatic : themePreference;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content =
    theme === "dark" ? "#101e2a" : "#f4f9fc";
  themePicker.value = themePreference;
}
themePicker.onchange = () => {
  themePreference = themePicker.value;
  try {
    localStorage.setItem(themeStorageKey, themePreference);
  } catch {
    // The selection still applies until the app is closed.
  }
  applyTheme();
};
if (deviceTheme?.addEventListener)
  deviceTheme.addEventListener("change", applyTheme);
else deviceTheme?.addListener?.(applyTheme);
tg?.onEvent?.("themeChanged", applyTheme);
applyTheme();
const root = document.querySelector("#content");
const notice = document.querySelector("#notice");
const newButton = document.querySelector("#new");
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icon = (name) =>
  `<svg class="icon" aria-hidden="true"><use href="#i-${name}" /></svg>`;
const quantity = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const duration = (seconds) => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
const artwork = (id, number = false) =>
  `<span class="artwork" data-art="${Number(id) % 6}" aria-hidden="true">${number ? `<span class="artwork-label">A PERSONAL SELECTION</span><span class="artwork-number">${String(id).padStart(2, "0")}</span>` : ""}</span>`;
let current = null;
let libraryFilter = "all";
let libraryQuery = "";
let generation = 0;
let pollTimer;
let searchTimer;
let searchVersion = 0;
let cancelDrag = null;

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": tg?.initData || "",
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      body.error || `Request failed (${response.status}). Please retry.`,
    );
    error.status = response.status;
    throw error;
  }
  return body;
}

function showError(error) {
  notice.textContent = error.message || String(error);
  notice.hidden = false;
  if (error.status === 401) {
    leaveView();
    newButton.disabled = true;
    sessionScreen(true);
  }
}

function clearError() {
  notice.textContent = "";
  notice.hidden = true;
}

function leaveView() {
  cancelDrag?.();
  cancelDrag = null;
  generation += 1;
  searchVersion += 1;
  current = null;
  clearTimeout(pollTimer);
  clearTimeout(searchTimer);
  tg?.BackButton?.hide();
  tg?.MainButton?.hide();
  return generation;
}

async function list() {
  const version = leaveView();
  clearError();
  root.innerHTML =
    '<p class="loading muted" role="status">Getting your playlists together…</p>';
  try {
    const playlists = await api("/playlists");
    if (version !== generation) return;
    renderLibrary(playlists);
  } catch (error) {
    if (version === generation) {
      root.innerHTML = `<div class="empty-state"><span class="empty-icon">${icon("note")}</span><h1>Your music will be right back.</h1><p>We couldn’t load your playlists. Give it another try.</p><button id="retry-list" class="primary">Retry loading playlists</button></div>`;
      root.querySelector("#retry-list").onclick = list;
      showError(error);
    }
  }
}

function renderLibrary(playlists) {
  if (!playlists.length) {
    libraryFilter = "all";
    libraryQuery = "";
  }
  const published = playlists.filter((p) => p.last_published_at).length;
  root.innerHTML = `<div class="page-heading">
    <div><p class="eyebrow">A LITTLE HOME FOR YOUR MUSIC</p><h1>Your playlists.</h1><p class="page-description">Collect the tracks. Set the mood. Share the music.</p></div>
    <div class="library-stats" aria-label="Library overview">
      <div><strong>${playlists.length}</strong><span>playlist${playlists.length === 1 ? "" : "s"}</span></div>
      <div><strong>${playlists.reduce((sum, p) => sum + p.track_count, 0)}</strong><span>tracks in playlists</span></div>
      <div><strong>${published}</strong><span>published</span></div>
    </div>
  </div>
  ${!playlists.length ? `<div class="intro-panel"><div><h2>From your vault.<br>Into their rotation.</h2><p>A few favorite tracks, a little rearranging, and a playlist worth sharing.</p></div><span class="intro-record" aria-hidden="true"></span></div>` : ""}
  ${
    playlists.length
      ? `<div class="library-toolbar">
    <div class="filters" role="group" aria-label="Filter playlists">
      ${[
        ["all", "All playlists", playlists.length],
        ["published", "Published", published],
        ["draft", "Drafts", playlists.length - published],
      ]
        .map(
          ([value, label, count]) =>
            `<button class="filter" data-filter="${value}" aria-pressed="${libraryFilter === value}">${label}<span class="filter-count">${count}</span></button>`,
        )
        .join("")}
    </div>
    <label class="library-search"><span class="sr-only">Search playlists</span>${icon("search")}<input id="library-search" type="search" placeholder="Find a playlist…" value="${esc(libraryQuery)}" autocomplete="off"></label>
  </div>`
      : ""
  }
  <div class="collection-heading"><h2>Your collection</h2><span id="collection-count" role="status"></span></div>
  <div id="playlist-grid" class="playlist-grid"></div>
  <p class="library-note">${icon("note")}<span>Music stays in your vault. Playlists bring it all together.</span></p>`;
  const renderCards = () => {
    const query = libraryQuery.trim().toLocaleLowerCase();
    const filtered = playlists.filter(
      (p) =>
        (libraryFilter === "all" ||
          (libraryFilter === "published"
            ? p.last_published_at
            : !p.last_published_at)) &&
        `${p.name} ${p.channel_title || ""}`
          .toLocaleLowerCase()
          .includes(query),
    );
    root.querySelector("#collection-count").textContent = quantity(
      filtered.length,
      "playlist",
    );
    root.querySelector("#playlist-grid").innerHTML = !playlists.length
      ? `<div class="empty-state"><span class="empty-icon">${icon("note")}</span><h2>Every good playlist starts somewhere.</h2><p>No playlists yet. Give your first one a name, then make it your own.</p><button class="primary" data-create>${icon("plus")}Create your first playlist</button></div>`
      : `${filtered
          .map((p) => {
            const unavailable = p.channel_id && !p.channel_available;
            const date = p.last_published_at
              ? new Date(p.last_published_at)
              : null;
            return `<button class="playlist-card" data-playlist="${p.id}" aria-label="Edit ${esc(p.name)}">
          ${artwork(p.id, true)}<span class="playlist-body">
            <span class="playlist-title-row"><strong class="playlist-title">${esc(p.name)}</strong>${icon("arrow")}</span>
            <span class="playlist-channel">${icon("channel")}<span>${esc(p.channel_title || "No channel selected")}</span></span>
            <span class="playlist-meta"><span>${icon("note")}${quantity(p.track_count, "track")}</span><span class="badge ${unavailable ? "warning" : date ? "" : "draft"}">${unavailable ? "Channel unavailable" : date ? "Published" : "Draft"}</span></span>
            ${date ? `<span class="playlist-date">Published <time datetime="${esc(p.last_published_at)}">${esc(date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }))}</time></span>` : ""}
          </span></button>`;
          })
          .join("")}
      ${!filtered.length ? `<div class="empty-state compact"><h3>No playlists found.</h3><p>Try a different name or filter.</p><button id="reset-filters" class="secondary">Show all playlists</button></div>` : ""}
      ${!query && libraryFilter === "all" ? `<button class="create-card" data-create><span class="create-symbol">${icon("plus")}</span><strong>A new mood. A new playlist.</strong><span>Make a little room for your next favorite collection.</span></button>` : ""}`;
    root.querySelectorAll("[data-playlist]").forEach((button) => {
      button.onclick = () => edit(button.dataset.playlist);
    });
    root.querySelectorAll("[data-create]").forEach((button) => {
      button.onclick = createPlaylist;
    });
    const reset = root.querySelector("#reset-filters");
    if (reset)
      reset.onclick = () => {
        libraryFilter = "all";
        libraryQuery = "";
        renderLibrary(playlists);
      };
  };
  root.querySelectorAll("[data-filter]").forEach((button) => {
    button.onclick = () => {
      libraryFilter = button.dataset.filter;
      root
        .querySelectorAll("[data-filter]")
        .forEach((filter) =>
          filter.setAttribute("aria-pressed", String(filter === button)),
        );
      renderCards();
    };
  });
  const input = root.querySelector("#library-search");
  if (input)
    input.oninput = () => {
      libraryQuery = input.value;
      renderCards();
    };
  renderCards();
  root.focus({ preventScroll: true });
}

function createPlaylist() {
  leaveView();
  clearError();
  tg?.BackButton?.show();
  root.innerHTML = `<div class="form-page"><button id="cancel-create" class="secondary back-button">${icon("back")}Your playlists</button>
    <p class="eyebrow">SOMETHING GOOD STARTS HERE</p><h1>Give it a name.</h1><p class="page-description">A mood, a moment, a new obsession. There’s a playlist for it.</p>
    <form id="create-form" class="form-card"><label for="playlist-name">Playlist name</label><input id="playlist-name" required maxlength="100" autocomplete="off" placeholder="e.g. Slow Sunday mornings" aria-describedby="name-hint">
    <p id="name-hint" class="field-hint">You can change this later. Tracks and a channel come next.</p>
    <div class="actions"><button type="submit" class="primary">Create playlist${icon("arrow")}</button></div></form></div>`;
  root.querySelector("#cancel-create").onclick = list;
  const version = generation;
  root.querySelector("#create-form").onsubmit = async (event) => {
    event.preventDefault();
    const button = event.submitter || root.querySelector("#create-form button");
    const name = root.querySelector("#playlist-name");
    if (!name.value.trim()) {
      name.setCustomValidity("Give your playlist a name.");
      name.reportValidity();
      return;
    }
    button.disabled = true;
    try {
      const playlist = await api("/playlists", {
        method: "POST",
        body: JSON.stringify({
          name: root.querySelector("#playlist-name").value,
        }),
      });
      if (version === generation) await edit(playlist.id);
    } catch (error) {
      if (version === generation) {
        button.disabled = false;
        showError(error);
      }
    }
  };
  root.querySelector("#playlist-name").oninput = (event) =>
    event.target.setCustomValidity("");
  root.querySelector("#playlist-name").focus();
}

async function edit(id) {
  const version = leaveView();
  clearError();
  tg?.BackButton?.show();
  root.innerHTML =
    '<p class="loading muted" role="status">Opening your playlist…</p>';
  try {
    const [playlist, channels] = await Promise.all([
      api(`/playlists/${id}`),
      api("/channels"),
    ]);
    if (version !== generation) return;
    current = {
      ...playlist,
      channels,
      query: "",
      busy: false,
      results: [],
      searched: false,
    };
    renderEditor();
    root.focus({ preventScroll: true });
    if (current.latest_job?.status === "running")
      pollJob(current, current.latest_job.id);
  } catch (error) {
    if (version === generation) {
      root.innerHTML = '<button id="back">Back to playlists</button>';
      root.querySelector("#back").onclick = list;
      showError(error);
    }
  }
}

function locked(state = current) {
  return !state || state.busy || state.latest_job?.status === "running";
}

function controls() {
  if (!current) return;
  root.querySelectorAll("[data-edit]").forEach((element) => {
    element.disabled =
      locked() ||
      element.hasAttribute("data-boundary") ||
      (element.dataset.add !== undefined &&
        current.tracks.some((t) => t.id === Number(element.dataset.add)));
  });
  const button = root.querySelector("#publish");
  if (button) {
    const clearing = !current.tracks.length && current.published_count;
    button.disabled =
      locked() ||
      !current.channel_id ||
      !current.channels.some(
        (channel) => channel.chat_id === current.channel_id,
      ) ||
      (!current.tracks.length && !current.published_count);
    button.textContent =
      current.latest_job?.status === "running"
        ? "Publishing…"
        : clearing
          ? "Clear published posts"
          : "Publish playlist";
  }
}

function renderEditor() {
  const state = current;
  if (!state) return;
  cancelDrag?.();
  cancelDrag = null;
  const settingsOpen = root.querySelector(".settings")?.open;
  const resultsScroll = root.querySelector("#results")?.scrollTop || 0;
  const focus = state.restoreFocus;
  state.restoreFocus = null;
  const unavailable =
    state.channel_id &&
    !state.channels.some((c) => c.chat_id === state.channel_id);
  const totalDuration = state.tracks.reduce(
    (sum, track) => sum + (track.duration || 0),
    0,
  );
  root.innerHTML = `<button id="back" class="secondary back-button">${icon("back")}Your playlists</button>
    <h1 class="sr-only">Playlist editor</h1>
    <div class="editor-heading">${artwork(state.id)}<div class="editor-heading-text"><p class="eyebrow">YOUR PERSONAL SELECTION</p><h2 class="page-title">${esc(state.name)}</h2>
      <div class="editor-meta"><span>${icon("note")}${quantity(state.tracks.length, "track")}</span>${totalDuration ? `<span>${icon("clock")}${Math.ceil(totalDuration / 60)} min</span>` : ""}<span class="badge ${state.last_published_at ? "" : "draft"}">${state.last_published_at ? "Published before" : "Draft"}</span></div>
    </div></div>
    <div class="editor-layout">
      <div class="editor-main">
        <section aria-labelledby="vault-title"><div class="section-heading"><h3 id="vault-title">Find your next track</h3><button id="browse" class="secondary browse-button" data-edit>Browse vault${icon("arrow")}</button></div>
          <label class="vault-search"><span class="sr-only">Search the current vault</span>${icon("search")}<input id="search" type="search" placeholder="Search by title, artist, or filename…" value="${esc(state.query)}" autocomplete="off" aria-describedby="search-hint" data-edit></label>
          <p id="search-hint" class="search-hint">Search your vault, then tap a track to add it.</p><section id="results" aria-live="polite" aria-label="Vault search results"></section>
        </section>
        <section class="track-section" aria-labelledby="tracks-title"><div class="section-heading"><h3 id="tracks-title">The lineup <span class="count-bubble">${state.tracks.length}</span></h3><span id="save-status" role="status">${state.saveFailed ? "Change not saved" : state.saved ? `${icon("check")}All changes saved` : "Changes save automatically"}</span></div>
          ${state.tracks.length > 1 ? '<p class="reorder-hint">Drag a handle or use the arrows to find your flow.</p>' : ""}
          <section id="tracks" aria-label="Playlist tracks">${renderTracks(state.tracks)}</section>
        </section>
      </div>
      <aside class="editor-sidebar" aria-label="Publishing and settings">
        <div class="sidebar-card"><h3>Ready when you are.</h3><p class="muted">Bring this playlist to your Telegram channel.</p>
          <label>Publish channel<select id="channel" data-edit><option value="">Choose a channel</option>
          ${unavailable ? `<option value="${state.channel_id}" selected disabled>Current channel unavailable</option>` : ""}
          ${state.channels.map((c) => `<option value="${c.chat_id}" ${c.chat_id === state.channel_id ? "selected" : ""}>${esc(c.title || c.chat_id)}</option>`).join("")}</select></label>
          ${!state.channels.length ? '<p class="publish-hint">No channels yet. Add the bot to a channel with Post Messages and Delete Messages permissions.</p>' : ""}
          <button id="publish" class="primary">Publish playlist</button>
          <p class="publish-hint">${!state.tracks.length && !state.published_count ? "Add a few tracks and choose a channel to get started." : "Publishing replaces the bot’s previous posts. If Telegram can’t delete older posts, remove them manually and retry."}</p>
          <section id="progress" tabindex="-1" aria-live="polite" aria-label="Publish status"></section>
        </div>
        <details class="settings" ${settingsOpen ? "open" : ""}><summary>Playlist settings</summary><form id="rename-form"><label>Name<input id="rename" value="${esc(state.name)}" maxlength="100" required data-edit></label><button id="save-name" class="outline" data-edit>Save name</button></form>
          <button id="delete" class="danger" data-edit>Delete playlist</button><p class="muted">Deleting also removes its published posts from the channel.</p>
        </details>
        <p class="editor-tip">${icon("check")}<span>Your audio stays in the vault. Only the playlist order and track references are saved here.</span></p>
      </aside>
    </div>`;
  root.querySelector("#back").onclick = list;
  root.querySelector("#publish").onclick = publishCurrent;
  root.querySelector("#channel").onchange = (event) => {
    const channel = event.target.value ? Number(event.target.value) : null;
    mutate(
      state,
      () =>
        api(`/playlists/${state.id}`, {
          method: "PATCH",
          body: JSON.stringify({ channel_id: channel }),
        }),
      () => {
        state.channel_id = channel;
      },
    );
  };
  root.querySelector("#rename-form").onsubmit = (event) => {
    event.preventDefault();
    const name = root.querySelector("#rename").value;
    mutate(
      state,
      () =>
        api(`/playlists/${state.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name }),
        }),
      () => {
        state.name = name.trim();
      },
    );
  };
  root.querySelector("#delete").onclick = () =>
    mutate(
      state,
      () => api(`/playlists/${state.id}`, { method: "DELETE" }),
      () => list(),
    );
  root.querySelector("#search").oninput = (event) => {
    state.query = event.target.value;
    const version = ++searchVersion;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search(state, version), 250);
  };
  root.querySelector("#browse").onclick = () => {
    clearTimeout(searchTimer);
    state.query = "";
    root.querySelector("#search").value = "";
    search(state, ++searchVersion);
  };
  wireTracks(state);
  renderResults();
  root.querySelector("#results").scrollTop = resultsScroll;
  renderProgress();
  controls();
  if (focus) {
    let element = root.querySelector(focus.selector);
    if (!element || element.disabled)
      element = root.querySelector(
        ".result:not(:disabled), [data-remove]:not(:disabled), #search:not(:disabled), #progress",
      );
    if (element && !element.disabled) {
      element.focus({ preventScroll: true });
      if (focus.start != null && element.setSelectionRange)
        element.setSelectionRange(focus.start, focus.end);
    }
  }
}

async function mutate(state, request, success, rollback = () => {}) {
  if (current !== state || locked(state)) return;
  const active = document.activeElement;
  if (active && root.contains(active)) {
    const attribute = ["data-add", "data-remove", "data-up", "data-down"].find(
      (key) => active.hasAttribute(key),
    );
    const trackId = active.closest("[data-track-id]")?.dataset.trackId;
    state.restoreFocus = active.id
      ? {
          selector: `#${active.id}`,
          start: active.selectionStart,
          end: active.selectionEnd,
        }
      : attribute
        ? {
            selector: trackId
              ? `[data-track-id="${trackId}"] [${attribute}]`
              : `[${attribute}="${active.getAttribute(attribute)}"]`,
          }
        : null;
  }
  state.busy = true;
  state.saveFailed = false;
  clearError();
  controls();
  const status = root.querySelector("#save-status");
  if (status) status.textContent = "Saving…";
  try {
    const result = await request();
    if (current === state) {
      state.saved = true;
      await success(result);
    }
  } catch (error) {
    if (current === state) {
      rollback();
      state.saveFailed = true;
      showError(error);
    }
  } finally {
    state.busy = false;
    if (current === state) renderEditor();
  }
}

async function search(state, version) {
  if (current !== state) return;
  root.querySelector("#results").innerHTML = '<p class="muted">Searching…</p>';
  try {
    const rows = await api(`/tracks?q=${encodeURIComponent(state.query)}`);
    if (current !== state || searchVersion !== version) return;
    state.results = rows;
    state.searched = true;
    renderResults();
  } catch (error) {
    if (current === state && searchVersion === version) {
      root.querySelector("#results").innerHTML =
        '<p class="muted">Search failed. Change the search to retry.</p>';
      showError(error);
    }
  }
}

function renderResults() {
  const state = current;
  const box = root.querySelector("#results");
  if (!box || !state) return;
  box.innerHTML = state.results.length
    ? state.results
        .map((track) => {
          const added = state.tracks.some((t) => t.id === track.id);
          return `<button class="result" data-add="${track.id}" ${added || locked() ? "disabled" : ""} data-edit aria-label="${added ? "Added" : "Add"} ${esc(track.title || track.file_name || "Untitled")}">
      <span class="result-info"><span class="result-title">${esc(track.title || track.file_name || "Untitled")}</span><span class="result-subtitle">${esc(track.performer || "Unknown artist")}${track.duration ? ` · ${duration(track.duration)}` : ""}</span></span><span class="result-add">${icon(added ? "check" : "plus")}${added ? "Added" : "Add"}</span></button>`;
        })
        .join("")
    : state.searched
      ? '<p class="muted">No matching tracks.</p>'
      : "";
  if (state.results.length === 50)
    box.insertAdjacentHTML(
      "beforeend",
      '<p class="search-hint">Showing the first 50 results. Refine your search to find more.</p>',
    );
  box.querySelectorAll("[data-add]").forEach(
    (button) =>
      (button.onclick = () => {
        const track = state.results.find(
          (t) => t.id === Number(button.dataset.add),
        );
        mutate(
          state,
          () =>
            api(`/playlists/${state.id}/tracks`, {
              method: "POST",
              body: JSON.stringify({ track_id: track.id }),
            }),
          () => {
            state.tracks.push(track);
          },
        );
      }),
  );
}

function renderTracks(tracks) {
  return tracks.length
    ? tracks
        .map(
          (
            track,
            index,
          ) => `<div class="track ${track.missing ? "missing" : ""}" data-track-id="${track.id}">
    <button class="handle secondary" data-edit aria-label="Drag ${esc(track.title || "track")}" title="Drag to reorder">${icon("grip")}</button>
    <span class="track-number" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
    <span class="track-name">${esc(track.title || track.file_name || "Untitled")}<small>${esc(track.performer || "Unknown artist")}</small>${track.missing ? '<small class="warning">Unavailable source</small>' : ""}</span>
    ${track.duration ? `<span class="track-duration">${duration(track.duration)}</span>` : ""}
    <div class="track-actions"><button class="secondary" data-up="${index}" data-edit aria-label="Move track ${index + 1} up" ${index === 0 ? "data-boundary" : ""}>${icon("up")}</button>
    <button class="secondary" data-down="${index}" data-edit aria-label="Move track ${index + 1} down" ${index === tracks.length - 1 ? "data-boundary" : ""}>${icon("down")}</button>
    <button class="secondary" data-remove="${track.id}" data-edit aria-label="Remove track ${index + 1}">${icon("close")}</button></div></div>`,
        )
        .join("")
    : `<div class="empty-state compact"><span class="empty-icon">${icon("note")}</span><h3>A blank canvas for good music.</h3><p>Find a track above or browse your vault.<br>Your lineup will appear here.</p></div>`;
}

function saveOrder(state, ids) {
  const before = [...state.tracks];
  const reordered = ids.map((id) => before.find((track) => track.id === id));
  return mutate(
    state,
    () =>
      api(`/playlists/${state.id}/order`, {
        method: "PUT",
        body: JSON.stringify({ track_ids: ids }),
      }),
    () => {
      state.tracks = reordered;
    },
  );
}

function wireTracks(state) {
  const box = root.querySelector("#tracks");
  box.querySelectorAll("[data-remove]").forEach(
    (button) =>
      (button.onclick = () => {
        const id = Number(button.dataset.remove);
        mutate(
          state,
          () =>
            api(`/playlists/${state.id}/tracks/${id}`, { method: "DELETE" }),
          () => {
            state.tracks = state.tracks.filter((t) => t.id !== id);
          },
        );
      }),
  );
  for (const [selector, direction] of [
    ["[data-up]", -1],
    ["[data-down]", 1],
  ]) {
    box.querySelectorAll(selector).forEach(
      (button) =>
        (button.onclick = () => {
          const index = Number(
            direction < 0 ? button.dataset.up : button.dataset.down,
          );
          const next = index + direction;
          if (next < 0 || next >= state.tracks.length) return;
          const ids = state.tracks.map((t) => t.id);
          [ids[index], ids[next]] = [ids[next], ids[index]];
          saveOrder(state, ids);
        }),
    );
  }
  box.querySelectorAll(".handle").forEach(
    (handle) =>
      (handle.onpointerdown = (event) => {
        if (locked(state) || event.button !== 0) return;
        event.preventDefault();
        const row = handle.closest("[data-track-id]");
        const pointer = event.pointerId;
        row.classList.add("dragging");
        handle.setPointerCapture(pointer);
        tg?.HapticFeedback?.selectionChanged();
        const finish = (save) => {
          if (!cancelDrag) return;
          cancelDrag = null;
          row.classList.remove("dragging");
          handle.onpointermove =
            handle.onpointerup =
            handle.onpointercancel =
            handle.onlostpointercapture =
              null;
          if (handle.hasPointerCapture(pointer))
            handle.releasePointerCapture(pointer);
          if (save) {
            const ids = [...box.querySelectorAll("[data-track-id]")].map((el) =>
              Number(el.dataset.trackId),
            );
            if (ids.some((id, index) => id !== state.tracks[index].id)) {
              saveOrder(state, ids);
              return;
            }
          }
          // Rebuild the saved order after cancellation or an unchanged gesture.
          if (current === state) {
            box.replaceChildren(
              ...state.tracks.map((track) =>
                box.querySelector(`[data-track-id="${track.id}"]`),
              ),
            );
          }
        };
        cancelDrag = () => finish(false);
        handle.onpointermove = (move) => {
          const target = document
            .elementFromPoint(move.clientX, move.clientY)
            ?.closest("[data-track-id]");
          if (target && target !== row && target.parentElement === box) {
            const rect = target.getBoundingClientRect();
            if (move.clientY < rect.top + rect.height / 2) target.before(row);
            else target.after(row);
            // Moving the captured node in the DOM releases capture in WebViews.
            handle.setPointerCapture(pointer);
          }
          if (move.clientY < 70) window.scrollBy(0, -16);
          if (move.clientY > window.innerHeight - 70) window.scrollBy(0, 16);
        };
        handle.onpointerup = () => finish(true);
        handle.onpointercancel = handle.onlostpointercapture = () =>
          finish(false);
      }),
  );
}

async function publishCurrent() {
  const state = current;
  if (!state || locked(state) || !state.channel_id) return;
  let jobId;
  await mutate(
    state,
    () => api(`/playlists/${state.id}/publish`, { method: "POST" }),
    (result) => {
      jobId = result.job_id;
      state.latest_job = {
        id: jobId,
        status: "running",
        progress: 0,
        total: state.tracks.length,
        skipped: 0,
      };
    },
  );
  if (jobId && current === state) pollJob(state, jobId);
}

function renderProgress() {
  const job = current?.latest_job;
  const box = root.querySelector("#progress");
  if (!job || !box) return;
  const label =
    {
      running: "Publishing",
      done: "Finished",
      error: "Publish failed",
      interrupted: "Publish interrupted",
    }[job.status] || job.status;
  box.innerHTML = `<div class="progress-heading"><strong>${esc(label)}</strong><span>${job.progress}/${job.total}</span></div>
    <progress aria-label="Publish progress" max="${job.total || 1}" value="${job.progress}"></progress>
    ${job.current_track ? `<p class="progress-track">${esc(job.current_track)}</p>` : ""}
    ${job.skipped ? `<p class="warning">Skipped ${job.skipped}: ${esc((job.skipped_titles || []).join(", "))}</p>` : ""}
    ${job.error ? `<p role="alert" class="warning">${esc(job.error)}</p>` : ""}`;
}

function pollJob(state, id) {
  clearTimeout(pollTimer);
  const tick = async () => {
    if (current !== state) return;
    try {
      const job = await api(`/jobs/${id}`);
      if (current !== state) return;
      state.latest_job = job;
      renderProgress();
      controls();
      if (job.status === "running") pollTimer = setTimeout(tick, 1000);
      else {
        const fresh = await api(`/playlists/${state.id}`);
        if (current === state) {
          Object.assign(state, fresh);
          renderEditor();
        }
      }
    } catch (error) {
      if (current !== state) return;
      showError(error);
      if (current !== state) return;
      const box = root.querySelector("#progress");
      box.insertAdjacentHTML(
        "beforeend",
        '<button id="retry-progress" class="secondary">Retry status</button>',
      );
      box.querySelector("#retry-progress").onclick = () => {
        clearError();
        renderProgress();
        pollJob(state, id);
      };
    }
  };
  tick();
}

newButton.onclick = createPlaylist;
document.querySelector("#home").onclick = (event) => {
  event.preventDefault();
  if (!newButton.disabled) list();
};
tg?.BackButton?.onClick(list);

function sessionScreen(expired = false) {
  root.innerHTML = `<div class="form-page"><p class="eyebrow">YOUR MUSIC, IN ORDER</p><h1>A little home for your music.</h1>
    <p class="page-description">Turn the tracks in your vault into playlists worth sharing.</p>
    <div class="empty-state session-card"><span class="empty-icon">${icon("telegram")}</span><h2>${expired ? "Let’s get you back in." : "See you in Telegram."}</h2>
      <p>${expired ? "Close this app and reopen it using “Open playlists” in the bot." : "Open this app using “Open playlists” in the bot to sign in."}</p>
      <button class="outline" popovertarget="help">${icon("help")}How it works</button>
    </div></div>`;
}

if (tg?.initData) list();
else {
  newButton.disabled = true;
  sessionScreen();
}

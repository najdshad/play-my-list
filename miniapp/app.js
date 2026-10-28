const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
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
let current = null;
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
    root.innerHTML =
      "<p>Close this app and reopen it using “Open playlists” in the bot.</p>";
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
  root.innerHTML = '<p class="muted">Loading playlists…</p>';
  try {
    const playlists = await api("/playlists");
    if (version !== generation) return;
    root.innerHTML = playlists.length
      ? playlists
          .map(
            (p) => `<button class="card playlist-card" data-playlist="${p.id}">
      <strong>${esc(p.name)}</strong><span class="muted">${p.track_count} tracks · ${esc(p.channel_title || "Choose a channel")}</span>
      ${p.channel_id && !p.channel_available ? '<span class="warning">Channel unavailable</span>' : ""}
      ${p.last_published_at ? `<span class="muted">Last published: ${esc(new Date(p.last_published_at).toLocaleString())}</span>` : ""}
    </button>`,
          )
          .join("")
      : '<p class="muted">No playlists yet. Create one to get started.</p>';
    root
      .querySelectorAll("[data-playlist]")
      .forEach(
        (button) => (button.onclick = () => edit(button.dataset.playlist)),
      );
  } catch (error) {
    if (version === generation) {
      root.innerHTML =
        '<button id="retry-list">Retry loading playlists</button>';
      root.querySelector("#retry-list").onclick = list;
      showError(error);
    }
  }
}

function createPlaylist() {
  leaveView();
  clearError();
  tg?.BackButton?.show();
  root.innerHTML = `<form id="create-form" class="card"><label>Playlist name<input id="playlist-name" required maxlength="100" autocomplete="off"></label>
    <div class="actions"><button type="submit">Create playlist</button><button type="button" id="cancel-create" class="secondary">Cancel</button></div></form>`;
  root.querySelector("#cancel-create").onclick = list;
  const version = generation;
  root.querySelector("#create-form").onsubmit = async (event) => {
    event.preventDefault();
    const button = event.submitter;
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
  root.querySelector("#playlist-name").focus();
}

async function edit(id) {
  const version = leaveView();
  clearError();
  tg?.BackButton?.show();
  root.innerHTML = '<p class="muted">Loading playlist…</p>';
  try {
    const [playlist, channels] = await Promise.all([
      api(`/playlists/${id}`),
      api("/channels"),
    ]);
    if (version !== generation) return;
    current = { ...playlist, channels, query: "", busy: false, results: [] };
    renderEditor();
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
      (element.dataset.add !== undefined &&
        current.tracks.some((t) => t.id === Number(element.dataset.add)));
  });
  const button = root.querySelector("#publish");
  if (button)
    button.disabled =
      locked() ||
      !current.channel_id ||
      (!current.tracks.length && !current.published_count);
  const main = tg?.MainButton;
  main?.setText?.(current.tracks.length ? "Publish" : "Clear published posts");
  main?.show();
  if (button?.disabled) main?.disable();
  else main?.enable();
}

function renderEditor() {
  const state = current;
  if (!state) return;
  cancelDrag?.();
  cancelDrag = null;
  const unavailable =
    state.channel_id &&
    !state.channels.some((c) => c.chat_id === state.channel_id);
  root.innerHTML = `<button id="back" class="secondary">← Playlists</button><h2>${esc(state.name)}</h2>
    <label>Publish channel<select id="channel" data-edit><option value="">Choose a channel</option>
      ${unavailable ? `<option value="${state.channel_id}" selected disabled>Current channel unavailable</option>` : ""}
      ${state.channels.map((c) => `<option value="${c.chat_id}" ${c.chat_id === state.channel_id ? "selected" : ""}>${esc(c.title || c.chat_id)}</option>`).join("")}</select></label>
    <div class="actions"><button id="publish">${state.tracks.length ? "Publish" : "Clear published posts"}</button><span id="save-status" class="muted" role="status"></span></div>
    <p class="muted">Publishing replaces tracked posts. If Telegram cannot delete old posts, clear them manually in Telegram and retry.</p>
    <section id="progress" aria-live="polite"></section>
    <label>Search the current vault<input id="search" type="search" placeholder="Title, artist or filename" value="${esc(state.query)}" data-edit></label>
    <section id="results" aria-live="polite"></section>
    <h3>Tracks</h3><p class="muted">Drag a handle or use the arrow buttons to change the order.</p><section id="tracks">${renderTracks(state.tracks)}</section>
    <details><summary>Playlist settings</summary><form id="rename-form"><label>Name<input id="rename" value="${esc(state.name)}" maxlength="100" required data-edit></label><button data-edit>Save name</button></form>
    <button id="delete" class="danger" data-edit>Delete playlist</button><section id="delete-confirm" hidden><p>Delete this playlist? Published posts must be cleared first.</p><button id="confirm-delete" class="danger" data-edit>Confirm deletion</button><button id="cancel-delete" class="secondary">Cancel</button></section></details>`;
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
  root.querySelector("#delete").onclick = () => {
    root.querySelector("#delete-confirm").hidden = false;
  };
  root.querySelector("#cancel-delete").onclick = () => {
    root.querySelector("#delete-confirm").hidden = true;
  };
  root.querySelector("#confirm-delete").onclick = () =>
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
  wireTracks(state);
  renderResults();
  renderProgress();
  controls();
}

async function mutate(state, request, success, rollback = () => {}) {
  if (current !== state || locked(state)) return;
  state.busy = true;
  clearError();
  controls();
  const status = root.querySelector("#save-status");
  if (status) status.textContent = "Saving…";
  try {
    const result = await request();
    if (current === state) await success(result);
  } catch (error) {
    if (current === state) {
      rollback();
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
    renderResults(true);
  } catch (error) {
    if (current === state && searchVersion === version) {
      root.querySelector("#results").innerHTML =
        '<p class="muted">Search failed. Change the search to retry.</p>';
      showError(error);
    }
  }
}

function renderResults(searched = false) {
  const state = current;
  const box = root.querySelector("#results");
  if (!box || !state) return;
  box.innerHTML = state.results.length
    ? state.results
        .map((track) => {
          const added = state.tracks.some((t) => t.id === track.id);
          return `<button class="card result" data-add="${track.id}" ${added || locked() ? "disabled" : ""} data-edit>
      <span>${esc(track.title || track.file_name || "Untitled")}${track.performer ? ` · ${esc(track.performer)}` : ""}</span><span>${added ? "Added" : "Add"}</span></button>`;
        })
        .join("")
    : searched
      ? '<p class="muted">No matching tracks.</p>'
      : "";
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
    <button class="handle secondary" data-edit aria-label="Drag ${esc(track.title || "track")}" title="Drag to reorder">☰</button>
    <span class="track-name">${esc(track.title || track.file_name || "Untitled")}${track.missing ? "<small>Unavailable source</small>" : ""}</span>
    <div class="track-actions"><button class="secondary" data-up="${index}" data-edit aria-label="Move track ${index + 1} up" ${index === 0 ? "data-boundary" : ""}>↑</button>
    <button class="secondary" data-down="${index}" data-edit aria-label="Move track ${index + 1} down" ${index === tracks.length - 1 ? "data-boundary" : ""}>↓</button>
    <button class="secondary" data-remove="${track.id}" data-edit aria-label="Remove track ${index + 1}">×</button></div></div>`,
        )
        .join("")
    : '<p class="muted">Add tracks using the search box.</p>';
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
  box.innerHTML = `<p><strong>${esc(label)}</strong>: ${job.progress}/${job.total}${job.current_track ? ` · ${esc(job.current_track)}` : ""}</p>
    <progress aria-label="Publish progress" max="${job.total || 1}" value="${job.progress}"></progress>
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
tg?.BackButton?.onClick(list);
tg?.MainButton?.onClick(publishCurrent);
if (tg?.initData) list();
else {
  newButton.disabled = true;
  root.innerHTML =
    "<p>Open this app using “Open playlists” in the bot to sign in.</p>";
}

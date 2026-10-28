"""Exercise the Mini App using agent-browser and the local browser_server fixture.

Start a fresh browser_server.py first. Requires `npx agent-browser` and Chrome.
Set AGENT_BROWSER_EXECUTABLE_PATH if Chrome is not in the default location.
This script only calls the local fake Telegram server.
"""

import asyncio
import json
import os
import shutil
import subprocess

from aiohttp import ClientSession

URL = "http://127.0.0.1:8765"
SESSION = "playlist-review"


def run(*args, stdin=None):
    executable = os.getenv("AGENT_BROWSER_BIN") or shutil.which("agent-browser")
    command = ([executable] if executable else ["npx", "--yes", "agent-browser"]) + [
        "--session",
        SESSION,
        "--json",
        *map(str, args),
    ]
    result = subprocess.run(
        command, input=stdin, text=True, capture_output=True, timeout=40
    )
    if result.returncode:
        raise AssertionError(f"{args}: {result.stdout}\n{result.stderr}")
    payload = json.loads(result.stdout)
    assert payload["success"], payload
    return payload.get("data", {})


def evaluate(code):
    return run("eval", "--stdin", stdin=code).get("result")


def wait(expression):
    run("wait", "--fn", expression)


def click(selector):
    run("scrollintoview", selector)
    run("click", selector)


def ids():
    return evaluate(
        "[...document.querySelectorAll('#tracks [data-track-id]')].map(e=>+e.dataset.trackId)"
    )


def ready():
    wait(
        "document.querySelector('#channel') && !document.querySelector('#channel').disabled"
    )


def server_state():
    return evaluate("fetch('/__test/state').then(r=>r.json())")


def failure(kind):
    evaluate(
        "fetch('/__test/failure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:"
        + json.dumps(kind)
        + "})}).then(r=>r.json())"
    )


async def touch_drag(bounds):
    # agent-browser exposes CDP, but its mouse command cannot exercise touch input.
    async with ClientSession() as client:
        async with client.ws_connect(run("get", "cdp-url")["cdpUrl"]) as ws:
            sequence = 0

            async def command(method, params=None, session=None):
                nonlocal sequence
                sequence += 1
                payload = {"id": sequence, "method": method, "params": params or {}}
                if session:
                    payload["sessionId"] = session
                await ws.send_json(payload)
                while True:
                    response = await ws.receive_json(timeout=10)
                    if response.get("id") == sequence:
                        assert "error" not in response, response
                        return response.get("result", {})

            targets = await command("Target.getTargets")
            target = next(
                t
                for t in targets["targetInfos"]
                if t["type"] == "page" and t["url"].startswith(URL)
            )
            attached = await command(
                "Target.attachToTarget",
                {"targetId": target["targetId"], "flatten": True},
            )
            session = attached["sessionId"]
            await command(
                "Emulation.setTouchEmulationEnabled", {"enabled": True}, session
            )
            try:
                for kind, fraction in [
                    ("touchStart", 0),
                    ("touchMove", 0.3),
                    ("touchMove", 0.7),
                    ("touchMove", 1),
                ]:
                    await command(
                        "Input.dispatchTouchEvent",
                        {
                            "type": kind,
                            "touchPoints": [
                                {
                                    "x": bounds["x"]
                                    + (bounds["tx"] - bounds["x"]) * fraction,
                                    "y": bounds["y"]
                                    + (bounds["ty"] - bounds["y"]) * fraction,
                                }
                            ],
                        },
                        session,
                    )
                await command(
                    "Input.dispatchTouchEvent",
                    {"type": "touchEnd", "touchPoints": []},
                    session,
                )
            finally:
                await command(
                    "Emulation.setTouchEmulationEnabled", {"enabled": False}, session
                )
                await command("Target.detachFromTarget", {"sessionId": session})


def main():
    run("open", URL)
    run("set", "viewport", 390, 844)
    wait("document.body.innerText.includes('No playlists yet')")
    click("#new")
    run("fill", "#playlist-name", "Browser trip")
    click("#create-form button[type=submit]")
    run("wait", "#search")
    run("select", "#channel", "-1001")
    ready()
    run("fill", "#search", "Band")
    run("wait", ".result")
    for tid in (1, 2, 3):
        click(f'[data-add="{tid}"]')
        wait(
            f"document.querySelector('[data-track-id=\"{tid}\"]') && !document.querySelector('#channel').disabled"
        )
        assert evaluate(f"document.querySelector('[data-add=\"{tid}\"]').disabled")
    assert ids() == [1, 2, 3]
    print("PASS create, choose channel, search and add tracks", flush=True)

    click('[data-down="0"]')
    wait(
        "document.querySelector('#tracks [data-track-id]').dataset.trackId === '2' && !document.querySelector('#channel').disabled"
    )
    assert ids() == [2, 1, 3]
    evaluate("""window.realFetch=window.fetch;window.failOrder=true;window.fetch=async(...args)=>{
      if(window.failOrder && args[1]?.method==='PUT'){window.failOrder=false;return new Response(JSON.stringify({error:'Injected reorder failure'}),{status:503,headers:{'Content-Type':'application/json'}})}
      return window.realFetch(...args)
    };true""")
    click('[data-up="1"]')
    wait(
        "document.querySelector('#notice').textContent.includes('Injected reorder failure')"
    )
    assert ids() == [2, 1, 3]
    evaluate("window.fetch=window.realFetch;true")
    print("PASS reorder persistence and failed-save rollback", flush=True)

    # Real pointer input, moving the first row after the last row.
    run("scrollintoview", "#tracks")
    bounds = evaluate(
        """(()=>{const h=document.querySelector('#tracks .handle').getBoundingClientRect();const t=document.querySelector('#tracks .track:last-child').getBoundingClientRect();return {x:h.x+h.width/2,y:h.y+h.height/2,tx:t.x+10,ty:t.bottom-4}})()"""
    )
    run("mouse", "move", bounds["x"], bounds["y"])
    run("mouse", "down", "left")
    run("mouse", "move", bounds["tx"], bounds["ty"])
    run("mouse", "up", "left")
    ready()
    assert ids() == [1, 3, 2], ids()
    print("PASS pointer drag to end of list at mobile viewport size", flush=True)

    for source, target, edge, expected in (
        ("first-child", "last-child", "bottom-4", [3, 2, 1]),
        ("last-child", "first-child", "top+4", [1, 3, 2]),
    ):
        run("scrollintoview", "#tracks")
        bounds = evaluate(
            f"""(()=>{{const h=document.querySelector('#tracks .track:{source} .handle').getBoundingClientRect();const t=document.querySelector('#tracks .track:{target}').getBoundingClientRect();return {{x:h.x+h.width/2,y:h.y+h.height/2,tx:t.x+10,ty:t.{edge}}}}})()"""
        )
        asyncio.run(touch_drag(bounds))
        ready()
        assert ids() == expected, ids()
    print("PASS native touch drag in both directions", flush=True)

    click("#publish")
    run("wait", "#progress progress")
    click("#back")
    run("wait", "[data-playlist]")
    click("[data-playlist]")
    wait("document.querySelector('#progress').textContent.includes('Finished')")
    ready()
    snapshot = server_state()
    assert len(snapshot["messages"]) == len(snapshot["tracked"]) == 3
    assert [row[2] for row in snapshot["messages"].values()] == [1, 3, 2]
    print("PASS publish order, navigation and restored job progress", flush=True)

    failure("delete")
    click("#publish")
    wait("document.querySelector('#progress').textContent.includes('48 hours')")
    ready()
    assert server_state()["messages"] == snapshot["messages"]
    assert server_state()["tracked"] == snapshot["tracked"]
    failure(None)
    print(
        "PASS deletion failure is visible and preserves output and tracking", flush=True
    )

    evaluate("""window.realFetch=window.fetch;window.failPoll=true;window.fetch=async(...args)=>{
      if(window.failPoll && String(args[0]).includes('/jobs/')){window.failPoll=false;return new Response(JSON.stringify({error:'Injected status failure'}),{status:503,headers:{'Content-Type':'application/json'}})}
      return window.realFetch(...args)
    };true""")
    click("#publish")
    run("wait", "#retry-progress")
    assert evaluate("document.querySelector('#search').disabled")
    click("#retry-progress")
    wait("document.querySelector('#progress').textContent.includes('Finished')")
    ready()
    evaluate("window.fetch=window.realFetch;true")
    assert len(server_state()["messages"]) == 3
    print("PASS republish cleanup and polling failure retry", flush=True)

    failure("copy")
    click("#publish")
    wait(
        "document.querySelector('#progress').textContent.includes('Posting permission revoked')"
    )
    ready()
    assert not evaluate("[...document.querySelectorAll('#tracks .missing')].length")
    failure(None)
    click("#publish")
    wait("document.querySelector('#progress').textContent.includes('Finished')")
    ready()
    print(
        "PASS destination error display and recovery without corrupting track availability",
        flush=True,
    )

    click("summary")
    run("fill", "#rename", "Renamed trip")
    click("#rename-form button")
    wait("document.querySelector('h2').textContent === 'Renamed trip'")
    ready()
    run("screenshot", "/tmp/play-my-list-browser.png")
    for tid in (1, 3, 2):
        click(f'[data-remove="{tid}"]')
        wait(
            f"!document.querySelector('[data-track-id=\"{tid}\"]') && !document.querySelector('#channel').disabled"
        )
    assert (
        evaluate("document.querySelector('#publish').textContent")
        == "Clear published posts"
    )
    click("#publish")
    wait(
        "document.querySelector('#progress').textContent.includes('Finished') && document.querySelector('#publish').disabled && !document.querySelector('#channel').disabled"
    )
    assert server_state()["messages"] == {}
    click("summary")
    click("#delete")
    click("#confirm-delete")
    wait("document.body.innerText.includes('No playlists yet')")
    print("PASS rename, remove tracks, clear posts and delete playlist", flush=True)

    evaluate("window.Telegram.WebApp.initData='invalid';true")
    click("#new")
    run("fill", "#playlist-name", "Unauthorized")
    click("#create-form button[type=submit]")
    wait("document.querySelector('#content').textContent.includes('reopen')")
    assert evaluate("document.querySelector('#new').disabled")
    assert server_state()["playlists"] == []
    print("PASS expired/invalid session returns to reopen screen", flush=True)
    errors = run("errors")
    assert not errors.get("errors"), errors
    print("PASS no unhandled browser errors", flush=True)


if __name__ == "__main__":
    main()

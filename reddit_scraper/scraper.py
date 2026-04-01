import asyncio
import os
import re
import random
import signal
import sys
from urllib.parse import urlparse, unquote
from playwright.async_api import async_playwright, Response, Page, BrowserContext

# ─── Configuration ────────────────────────────────────────────────
SAVE_DIR = "reddit_high_res"
MAX_SCROLL_DURATION = 600          # auto-scroll cap (seconds)
MIN_IMAGE_BYTES = 1024             # skip tiny placeholders (< 1 KB)
MIN_PREVIEW_WIDTH = 640            # skip small preview.redd.it thumbs

# Host filters — images are saved ONLY when the URL contains one of these.
# Leave the list empty OR set CAPTURE_ALL_IMAGES = True to grab everything.
IMAGE_HOST_FILTERS = [
    "preview.redd.it",
    "i.redd.it",
]
CAPTURE_ALL_IMAGES = False         # True → ignores the filter list above
# ──────────────────────────────────────────────────────────────────

downloaded: set[str] = set()
download_count: int = 0
shutdown_event = asyncio.Event()
# Keep a reference to every tracked page so the scroll loop can
# always target whichever page is currently active.
active_pages: list[Page] = []


# ──────────────────────────────────────────────────────────────────
#  Helpers
# ──────────────────────────────────────────────────────────────────
def build_filename(url: str) -> str | None:
    """
    Derive a filesystem-safe filename from an image URL.

    https://preview.redd.it/abc123.jpg?width=1080  →  abc123.jpg
    https://i.redd.it/xyz789.png                   →  xyz789.png
    https://example.com/path/to/photo.webp?v=2     →  photo.webp
    """
    try:
        parsed = urlparse(url)
        raw = os.path.basename(parsed.path)
        raw = unquote(raw)
        raw = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", raw)

        if not raw or raw in ("/", "."):
            return None

        valid_ext = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".svg")
        if not raw.lower().endswith(valid_ext):
            raw += ".jpg"

        return raw
    except Exception:
        return None


def url_matches_filter(url: str) -> bool:
    """Return True when the URL is from an allowed image host."""
    if CAPTURE_ALL_IMAGES:
        return True
    return any(host in url for host in IMAGE_HOST_FILTERS)


def get_starting_url() -> str:
    """Read the starting URL from argv or an interactive prompt."""
    if len(sys.argv) > 1:
        url = sys.argv[1]
    else:
        url = input("  🌐  Enter starting URL (default: r/SUBREDDITNAME): ").strip()

    if not url:
        url = "https://www.reddit.com/r/SUBREDDITNAME/"
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    return url


# ──────────────────────────────────────────────────────────────────
#  Response handler (attached to EVERY page the browser opens)
# ──────────────────────────────────────────────────────────────────
async def handle_response(response: Response) -> None:
    """Intercept image responses, filter, and save to disk."""
    global download_count

    try:
        url = response.url
        resource_type = response.request.resource_type

        # Gate 1 – only images
        if resource_type != "image":
            return

        # Gate 2 – host allow-list
        if not url_matches_filter(url):
            return

        # Gate 3 – skip small preview.redd.it thumbnails
        if "preview.redd.it" in url:
            m = re.search(r"[?&]width=(\d+)", url)
            if m and int(m.group(1)) < MIN_PREVIEW_WIDTH:
                return

        # Gate 4 – deduplicate
        filename = build_filename(url)
        if filename is None or filename in downloaded:
            return

        # Gate 5 – response must be OK-ish
        if response.status < 200 or response.status >= 400:
            return

        body = await response.body()
        if not body or len(body) < MIN_IMAGE_BYTES:
            return

        filepath = os.path.join(SAVE_DIR, filename)

        # If a file with this name already exists, make it unique
        if os.path.exists(filepath):
            name, ext = os.path.splitext(filename)
            filename = f"{name}_{download_count}{ext}"
            filepath = os.path.join(SAVE_DIR, filename)

        with open(filepath, "wb") as f:
            f.write(body)

        downloaded.add(filename)
        download_count += 1
        size_kb = len(body) / 1024
        print(f"  ✅  [{download_count:>4}] {filename}  ({size_kb:,.1f} KB)")

    except Exception as exc:
        # Body unavailable, request cancelled, page navigated away, etc.
        short_url = response.url[:80] if response else "?"
        print(f"  ⚠️  skip: {short_url}… — {exc}")


# ──────────────────────────────────────────────────────────────────
#  Page wiring — attach listeners to every new page / tab
# ──────────────────────────────────────────────────────────────────
def wire_page(page: Page) -> None:
    """Attach the response listener + close handler to a page."""
    page.on("response", handle_response)
    page.on("close", lambda _: _remove_page(page))
    active_pages.append(page)
    print(f"  📄  tracking page: {page.url or '(blank)'}")


def _remove_page(page: Page) -> None:
    if page in active_pages:
        active_pages.remove(page)
    if not active_pages:
        # All tabs closed → signal shutdown
        shutdown_event.set()


def wire_context(context: BrowserContext) -> None:
    """Listen for new tabs / pop-ups so we can attach our handler."""
    context.on("page", lambda page: wire_page(page))
    context.on("close", lambda _: shutdown_event.set())


# ──────────────────────────────────────────────────────────────────
#  Human-like auto-scroll (resilient to navigation & new pages)
# ──────────────────────────────────────────────────────────────────
async def human_scroll() -> None:
    """
    Scroll the most-recently-focused page with random, human-like timing.
    Survives full-page navigations and tab switches.
    """
    elapsed = 0.0

    while elapsed < MAX_SCROLL_DURATION and not shutdown_event.is_set():
        # Always target the last page in the list (most recently opened)
        if not active_pages:
            await asyncio.sleep(1)
            elapsed += 1
            continue

        page = active_pages[-1]

        try:
            # --- random scroll down ---
            distance = random.randint(300, 900)
            await page.evaluate(
                f"window.scrollBy({{ top: {distance}, behavior: 'smooth' }})"
            )

            pause = random.uniform(1.0, 4.0)
            await asyncio.sleep(pause)
            elapsed += pause

            # --- occasional long pause ("reading") ---
            if random.random() < 0.12:
                long_pause = random.uniform(3.0, 7.0)
                print(f"  👀  pausing {long_pause:.1f}s …")
                await asyncio.sleep(long_pause)
                elapsed += long_pause

            # --- occasional scroll up ("re-reading") ---
            if random.random() < 0.08:
                up = random.randint(100, 300)
                await page.evaluate(
                    f"window.scrollBy({{ top: -{up}, behavior: 'smooth' }})"
                )
                await asyncio.sleep(random.uniform(0.5, 1.5))

        except Exception:
            # Page navigated, closed, or crashed — wait a moment and retry
            await asyncio.sleep(2)
            elapsed += 2

    print(f"\n  🏁  auto-scroll finished — {download_count} images saved.")


# ──────────────────────────────────────────────────────────────────
#  Main
# ──────────────────────────────────────────────────────────────────
async def main() -> None:
    os.makedirs(SAVE_DIR, exist_ok=True)
    start_url = get_starting_url()

    print()
    print("  ╔══════════════════════════════════════════════════╗")
    print("  ║        Reddit / Web Image Scraper                ║")
    print("  ╠══════════════════════════════════════════════════╣")
    print(f"  ║  Start URL : {start_url[:40]:<40}║")
    print(f"  ║  Save dir  : ./{SAVE_DIR + '/':<40}║")
    print(f"  ║  Hosts     : {'ALL' if CAPTURE_ALL_IMAGES else ', '.join(IMAGE_HOST_FILTERS):<40}║")
    print("  ║  Close the browser at any time to stop.         ║")
    print("  ║  You can click links / visit other sites freely. ║")
    print("  ╚══════════════════════════════════════════════════╝")
    print()

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=False,
            slow_mo=50,
            args=["--disable-blink-features=AutomationControlled"],
        )

        context = await browser.new_context(
            viewport={"width": 1366, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/125.0.0.0 Safari/537.36"
            ),
        )

        # Wire up context-level listener for new tabs
        wire_context(context)

        # Open the first page and wire it
        page = await context.new_page()
        wire_page(page)

        try:
            await page.goto(start_url, wait_until="domcontentloaded", timeout=30_000)
        except Exception as exc:
            print(f"  ⚠️  initial navigation warning: {exc}")
            # Don't exit — the browser is open, the user can navigate manually

        await asyncio.sleep(2)

        try:
            await human_scroll()
        except KeyboardInterrupt:
            print("\n  ⌨️  interrupted.")
        except Exception as exc:
            print(f"\n  ❌  unexpected error: {exc}")

        # Wait for the user to close the browser (if scroll ended first)
        if not shutdown_event.is_set():
            print("  ⏳  auto-scroll ended. Browser stays open — browse freely!")
            print("       Close the browser window when you're done.\n")
            await shutdown_event.wait()

        try:
            await browser.close()
        except Exception:
            pass

    print(f"\n  ✅  done. {download_count} unique images saved to ./{SAVE_DIR}/\n")


if __name__ == "__main__":
    signal.signal(signal.SIGINT, lambda *_: shutdown_event.set())
    asyncio.run(main())

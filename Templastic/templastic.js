/**
 * ═══════════════════════════════════════════════════════════════
 * <templastic-import> — High-Performance HTML Import Component
 * ═══════════════════════════════════════════════════════════════
 *
 * A self-contained Web Component that fetches external HTML
 * fragments, extracts and scopes their CSS, and injects the
 * content into an encapsulated Shadow DOM — all with lazy
 * loading and zero rendering jank.
 *
 * @example
 *   <templastic-import src="/partials/footer.html"></templastic-import>
 *   <templastic-import src="/partials/hero.html" loading="eager"></templastic-import>
 *
 * @fires templastic-loaded  - Dispatched after successful injection
 * @fires templastic-error   - Dispatched on fetch or parse failure
 *
 * @attr {string}  src      - URL of the HTML fragment to import
 * @attr {string}  loading  - "lazy" (default) | "eager"
 */
class TemplasticImport extends HTMLElement {

  // ─── Global Singleton Cache ──────────────────────────────────
  // Shared across ALL instances. Keyed by resolved absolute URL.
  // Prevents duplicate network requests even if 50 components
  // reference the same file.

  /** @type {Map<string, string>} Resolved URL → raw HTML string */
  static _cache = new Map();

  /** @type {Map<string, Promise<string>>} In-flight request dedup */
  static _pending = new Map();

  /** @type {DOMParser} Shared parser instance (avoids re-allocation) */
  static _parser = new DOMParser();

  // ─── Observed Attributes ─────────────────────────────────────

  static get observedAttributes() {
    return ['src', 'loading'];
  }

  // ─── Constructor ─────────────────────────────────────────────

  constructor() {
    super();

    /**
     * Attach Shadow DOM in "open" mode for encapsulation.
     * All imported styles live inside here — they cannot leak
     * out and corrupt the parent document's styling.
     */
    this.attachShadow({ mode: 'open' });

    /** @type {IntersectionObserver|null} */
    this._observer = null;

    /** @type {AbortController|null} For cancelling in-flight fetches */
    this._abortController = null;

    /** @type {boolean} Guard against double-loading */
    this._hasLoaded = false;

    /** @type {boolean} Track connection state */
    this._isConnected = false;
  }

  // ─── Lifecycle: Connected ────────────────────────────────────

  connectedCallback() {
    this._isConnected = true;

    // Set initial ARIA role for accessibility
    if (!this.hasAttribute('role')) {
      this.setAttribute('role', 'presentation');
    }

    // Set a minimal host style so the element isn't invisible
    // before content loads (prevents layout shift)
    this.shadowRoot.innerHTML = `
      <style>:host { display: block; }</style>
      <slot></slot>
    `;

    this._initLoading();
  }

  // ─── Lifecycle: Disconnected ─────────────────────────────────

  disconnectedCallback() {
    this._isConnected = false;
    this._destroyObserver();
    this._abortFetch();
  }

  // ─── Lifecycle: Attribute Changed ────────────────────────────

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;

    if (name === 'src' && this._isConnected) {
      // Reset and re-trigger the loading pipeline
      this._hasLoaded = false;
      this._abortFetch();
      this._initLoading();
    }

    if (name === 'loading' && this._isConnected) {
      this._destroyObserver();
      this._initLoading();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: LAZY LOADING (Intersection Observer)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Decides whether to load eagerly or set up lazy observation.
   * Default behavior is "lazy" — only fetches when the element
   * is about to scroll into view.
   */
  _initLoading() {
    const src = this.getAttribute('src');
    if (!src) return;

    const mode = this.getAttribute('loading') || 'lazy';

    if (mode === 'eager') {
      // Skip the observer, load immediately
      this._beginLoad();
      return;
    }

    // Lazy: use IntersectionObserver with a generous rootMargin
    // so we start fetching ~250px before the user scrolls to it
    if ('IntersectionObserver' in window) {
      this._observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              this._destroyObserver();
              this._beginLoad();
              return; // Only need the first intersection
            }
          }
        },
        {
          rootMargin: '250px 0px',  // Pre-fetch buffer zone
          threshold: 0              // Any pixel visible triggers it
        }
      );
      this._observer.observe(this);
    } else {
      // Fallback: no IntersectionObserver support → load eagerly
      this._beginLoad();
    }
  }

  /**
   * Tears down the IntersectionObserver to free memory.
   */
  _destroyObserver() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2: FETCHING (with Singleton Cache + Request Dedup)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Entry point for the loading pipeline.
   * Prevents double-loading and handles errors gracefully.
   */
  async _beginLoad() {
    if (this._hasLoaded) return;
    this._hasLoaded = true;

    const src = this.getAttribute('src');
    if (!src) return;

    // Resolve relative URL to absolute for consistent cache keys
    const resolvedURL = new URL(src, document.baseURI).href;

    try {
      this.setAttribute('aria-busy', 'true');
      const rawHTML = await this._fetchWithCache(resolvedURL);

      // Guard: component may have been disconnected during fetch
      if (!this._isConnected) return;

      this._processHTML(rawHTML, resolvedURL);
    } catch (error) {
      if (error.name === 'AbortError') return; // Intentional cancellation

      console.error(
        `[templastic-import] Failed to load "${src}":`,
        error
      );

      this.setAttribute('aria-busy', 'false');
      this.setAttribute('data-state', 'error');

      this.dispatchEvent(
        new CustomEvent('templastic-error', {
          detail: { error, src },
          bubbles: true,
          composed: true // Crosses shadow DOM boundaries
        })
      );
    }
  }

  /**
   * Fetches HTML with a two-tier caching strategy:
   *
   *  Tier 1: Static cache (Map) — instant return for already-fetched URLs
   *  Tier 2: Pending promise dedup — if two components request the same
   *          URL simultaneously, only ONE network request is made
   *
   * @param   {string} url - Absolute URL to fetch
   * @returns {Promise<string>} Raw HTML string
   */
  async _fetchWithCache(url) {
    // ── Tier 1: Resolved cache hit ─────────────────────────────
    if (TemplasticImport._cache.has(url)) {
      return TemplasticImport._cache.get(url);
    }

    // ── Tier 2: In-flight request deduplication ────────────────
    if (TemplasticImport._pending.has(url)) {
      return TemplasticImport._pending.get(url);
    }

    // ── Tier 3: New network request ────────────────────────────
    this._abortController = new AbortController();

    const request = fetch(url, {
      signal: this._abortController.signal,
      // Leverage browser HTTP cache as an additional layer
      cache: 'default'
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} — ${response.statusText}`);
        }
        return response.text();
      })
      .then((html) => {
        // Store in singleton cache for all future consumers
        TemplasticImport._cache.set(url, html);
        TemplasticImport._pending.delete(url);
        return html;
      })
      .catch((error) => {
        // Clean up pending entry on failure so retries are possible
        TemplasticImport._pending.delete(url);
        throw error;
      });

    // Register as pending so concurrent requests reuse this promise
    TemplasticImport._pending.set(url, request);

    return request;
  }

  /**
   * Cancels any in-flight fetch for this specific instance.
   */
  _abortFetch() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3: PARSING & STYLE EXTRACTION (DOMParser)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Parses the raw HTML string and separates concerns:
   *
   *  ┌───────────────────────────────────────────────────────┐
   *  │  Raw HTML String                                      │
   *  ├───────────────┬───────────────────┬───────────────────┤
   *  │  <style> tags │  <link> elements  │  style="" attrs   │
   *  │  → scoped in  │  → resolved URLs  │  → applied to     │
   *  │    Shadow DOM  │    in Shadow DOM  │    :host element  │
   *  └───────────────┴───────────────────┴───────────────────┘
   *
   * @param {string} rawHTML     - The fetched HTML string
   * @param {string} resolvedURL - The base URL for resolving relative paths
   */
  _processHTML(rawHTML, resolvedURL) {
    // Use the shared DOMParser (no allocation per call)
    const doc = TemplasticImport._parser.parseFromString(rawHTML, 'text/html');

    // ── 3a. Extract <style> blocks ─────────────────────────────
    const styleElements = doc.querySelectorAll('style');
    const extractedCSS = [];

    styleElements.forEach((styleEl) => {
      extractedCSS.push(styleEl.textContent);
      styleEl.remove(); // Remove from parsed DOM to avoid duplication
    });

    // ── 3b. Extract and resolve <link rel="stylesheet"> ────────
    const linkElements = doc.querySelectorAll('link[rel="stylesheet"]');
    const resolvedLinks = [];

    linkElements.forEach((linkEl) => {
      const href = linkEl.getAttribute('href');
      if (href) {
        // Resolve relative href against the source URL
        const resolvedHref = new URL(href, resolvedURL).href;
        const clonedLink = linkEl.cloneNode(true);
        clonedLink.setAttribute('href', resolvedHref);
        resolvedLinks.push(clonedLink);
      }
      linkEl.remove();
    });

    // ── 3c. Extract root-level inline style="" attribute ───────
    //    If the imported HTML has a single root element like:
    //      <footer style="background: #333; color: white;">
    //    we pull that style and apply it to the <templastic-import>
    //    host element itself.
    let hostInlineStyle = null;
    const rootChildren = doc.body.children;

    if (rootChildren.length > 0) {
      const rootElement = rootChildren[0];
      const inlineStyleAttr = rootElement.getAttribute('style');

      if (inlineStyleAttr && inlineStyleAttr.trim().length > 0) {
        hostInlineStyle = inlineStyleAttr;
        rootElement.removeAttribute('style');
      }
    }

    // ── 3d. Resolve relative URLs in remaining content ─────────
    this._resolveRelativeURLs(doc, resolvedURL);

    // ── Gather the cleaned content HTML ────────────────────────
    const contentHTML = doc.body.innerHTML;

    // ── Schedule injection on next animation frame ─────────────
    requestAnimationFrame(() => {
      if (!this._isConnected) return; // Guard against disconnect

      this._injectIntoShadow(
        extractedCSS,
        resolvedLinks,
        contentHTML,
        hostInlineStyle
      );
    });
  }

  /**
   * Resolves relative `src`, `href`, and `action` attributes
   * inside the parsed document so images, links, and forms
   * work correctly regardless of where the partial lives.
   *
   * @param {Document} doc         - Parsed document
   * @param {string}   baseURL     - Base URL for resolution
   */
  _resolveRelativeURLs(doc, baseURL) {
    const selectors = [
      { attr: 'src',    query: '[src]'    },
      { attr: 'href',   query: 'a[href], area[href]' },
      { attr: 'action', query: 'form[action]' },
      { attr: 'srcset', query: '[srcset]' },
      { attr: 'poster', query: 'video[poster]' }
    ];

    selectors.forEach(({ attr, query }) => {
      doc.querySelectorAll(query).forEach((el) => {
        const value = el.getAttribute(attr);
        if (!value || value.startsWith('data:') || value.startsWith('#')) return;

        try {
          if (attr === 'srcset') {
            // srcset has a special comma-separated format
            const resolved = value
              .split(',')
              .map((entry) => {
                const parts = entry.trim().split(/\s+/);
                parts[0] = new URL(parts[0], baseURL).href;
                return parts.join(' ');
              })
              .join(', ');
            el.setAttribute(attr, resolved);
          } else {
            el.setAttribute(attr, new URL(value, baseURL).href);
          }
        } catch {
          // Invalid URL — leave as-is
        }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE 4: DOM INJECTION (Shadow DOM + rAF)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Performs the final, batched DOM write inside a single
   * requestAnimationFrame to avoid layout thrashing.
   *
   * Uses a DocumentFragment for a single reflow/repaint.
   *
   * @param {string[]}    cssBlocks      - Extracted <style> contents
   * @param {HTMLElement[]} linkElements  - Cloned <link> elements
   * @param {string}       contentHTML    - Cleaned HTML content
   * @param {string|null}  hostStyle      - Inline style for host element
   */
  _injectIntoShadow(cssBlocks, linkElements, contentHTML, hostStyle) {
    const shadow = this.shadowRoot;
    const fragment = document.createDocumentFragment();

    // ── Host-level base styles ─────────────────────────────────
    const baseStyle = document.createElement('style');
    baseStyle.textContent = `
      :host {
        display: block;
        contain: content;
      }
      :host([hidden]) {
        display: none;
      }
    `;
    fragment.appendChild(baseStyle);

    // ── Scoped <style> blocks ──────────────────────────────────
    // All CSS is injected INSIDE the Shadow DOM.
    // This means:
    //   ✅ Styles apply correctly to the imported content
    //   ✅ Styles CANNOT leak out to the parent document
    //   ✅ Parent document styles CANNOT break imported content
    if (cssBlocks.length > 0) {
      const scopedStyle = document.createElement('style');
      scopedStyle.setAttribute('data-templastic', 'scoped');
      scopedStyle.textContent = cssBlocks.join('\n\n');
      fragment.appendChild(scopedStyle);
    }

    // ── External stylesheet <link> elements ────────────────────
    linkElements.forEach((link) => {
      link.setAttribute('data-templastic', 'external');
      fragment.appendChild(link);
    });

    // ── Content HTML ───────────────────────────────────────────
    // Use a temporary container to parse, then move nodes
    const temp = document.createElement('template');
    temp.innerHTML = contentHTML;
    fragment.appendChild(temp.content.cloneNode(true));

    // ── Single DOM write: clear and inject ─────────────────────
    shadow.innerHTML = '';
    shadow.appendChild(fragment);

    // ── Apply root inline style to host element ────────────────
    if (hostStyle) {
      // Merge with existing styles rather than overwriting
      const existingStyle = this.style.cssText;
      this.style.cssText = existingStyle
        ? `${existingStyle}; ${hostStyle}`
        : hostStyle;
    }

    // ── Update state ───────────────────────────────────────────
    this.setAttribute('aria-busy', 'false');
    this.setAttribute('data-state', 'loaded');

    // ── Dispatch success event ─────────────────────────────────
    this.dispatchEvent(
      new CustomEvent('templastic-loaded', {
        detail: {
          src: this.getAttribute('src'),
          stylesExtracted: cssBlocks.length,
          linksResolved: linkElements.length,
          hostStyleApplied: !!hostStyle
        },
        bubbles: true,
        composed: true
      })
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════

  /**
   * Forces a reload of the content, bypassing the cache.
   * Useful for dynamic content that changes server-side.
   *
   * @returns {Promise<void>}
   */
  async reload() {
    const src = this.getAttribute('src');
    if (!src) return;

    const resolvedURL = new URL(src, document.baseURI).href;

    // Evict from cache
    TemplasticImport._cache.delete(resolvedURL);

    // Reset and reload
    this._hasLoaded = false;
    this._destroyObserver();
    await this._beginLoad();
  }

  /**
   * Clears the entire global cache.
   * Affects ALL instances of <templastic-import>.
   */
  static clearCache() {
    TemplasticImport._cache.clear();
    TemplasticImport._pending.clear();
  }

  /**
   * Preloads a URL into the cache without rendering it.
   * Useful for prefetching content you know you'll need.
   *
   * @param   {string} url - URL to prefetch
   * @returns {Promise<string>} The fetched HTML
   */
  static async prefetch(url) {
    const resolvedURL = new URL(url, document.baseURI).href;

    if (TemplasticImport._cache.has(resolvedURL)) {
      return TemplasticImport._cache.get(resolvedURL);
    }

    const html = await fetch(resolvedURL).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    });

    TemplasticImport._cache.set(resolvedURL, html);
    return html;
  }
}

// ═══════════════════════════════════════════════════════════════
// REGISTRATION
// ═══════════════════════════════════════════════════════════════

if (!customElements.get('templastic-import')) {
  customElements.define('templastic-import', TemplasticImport);
}

export default TemplasticImport;

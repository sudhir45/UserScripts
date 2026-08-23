// ==UserScript==
// @name         Hover Image Preview
// @namespace    https://local.userscripts/
// @version      2.0.0
// @description  Enlarge images on hover and provide open/download controls.
// @author       You
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

(() => {
  'use strict';

  const ROOT_ID = 'hip-root';
  const IMAGE_EXTENSION =
    /\.(?:avif|bmp|gif|ico|jpe?g|jfif|png|svg|webp)(?:$|[?#])/i;

  const IMAGE_ATTRIBUTES = [
    'data-full',
    'data-full-src',
    'data-fullsize',
    'data-hi-res',
    'data-image',
    'data-large',
    'data-large-src',
    'data-original',
    'data-original-src',
    'data-src',
    'data-url',
    'data-zoom-image'
  ];

  const defaults = {
    enabled: true,
    delayMs: 250,
    hideDelayMs: 180,
    maxWidthVw: 84,
    maxHeightVh: 84,
    minSizePx: 36,
    preferLinkedImage: true,
    showCaption: true
  };

  const settings = Object.assign(
    {},
    defaults,
    GM_getValue('settings', {})
  );

  let hoverTimer = 0;
  let hideTimer = 0;
  let hoveredElement = null;
  let currentTarget = null;
  let currentImage = null;
  let currentUrl = null;
  let requestNumber = 0;
  let pinned = false;

  let pointer = {
    x: innerWidth / 2,
    y: innerHeight / 2
  };

  const root = document.createElement('div');

  root.id = ROOT_ID;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Image preview');

  root.innerHTML = `
    <div class="hip-stage">
      <div class="hip-status">Loading…</div>
      <img class="hip-image" alt="Hover preview">
    </div>

    <div class="hip-bar">
      <span class="hip-info"></span>
      <button type="button" data-action="download">Download</button>
      <button type="button" data-action="open">Open</button>
      <button type="button" data-action="pin">Pin</button>
      <button type="button" data-action="close">×</button>
    </div>
  `;

  const style = document.createElement('style');

  style.textContent = `
    #${ROOT_ID} {
      all: initial;
      position: fixed;
      z-index: 2147483647;
      display: none;
      box-sizing: border-box;
      overflow: hidden;
      color: #f5f5f5;
      background: rgba(18, 18, 20, 0.97);
      border: 1px solid rgba(255, 255, 255, 0.24);
      border-radius: 9px;
      box-shadow: 0 12px 44px rgba(0, 0, 0, 0.58);
      font: 12px/1.3 system-ui, -apple-system,
        BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    #${ROOT_ID},
    #${ROOT_ID} * {
      box-sizing: border-box;
    }

    #${ROOT_ID}.hip-visible {
      display: flex;
      flex-direction: column;
    }

    #${ROOT_ID} .hip-stage {
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 120px;
      min-height: 80px;
      overflow: hidden;
      background: #0b0b0c;
    }

    #${ROOT_ID} .hip-image {
      display: none;
      width: auto;
      height: auto;
      object-fit: contain;
      background: #0b0b0c;
      max-width: ${settings.maxWidthVw}vw;
      max-height: calc(${settings.maxHeightVh}vh - 38px);
    }

    #${ROOT_ID} .hip-image.hip-active {
      display: block;
    }

    #${ROOT_ID} .hip-status {
      padding: 30px 38px;
      color: #c9c9cf;
    }

    #${ROOT_ID} .hip-bar {
      display: flex;
      align-items: center;
      gap: 5px;
      min-height: 34px;
      padding: 4px 5px 4px 9px;
      background: #1b1b1f;
      border-top: 1px solid rgba(255, 255, 255, 0.12);
    }

    #${ROOT_ID} .hip-info {
      min-width: 0;
      flex: 1 1 auto;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      color: #d5d5db;
      direction: ltr;
    }

    #${ROOT_ID} button {
      all: initial;
      box-sizing: border-box;
      cursor: pointer;
      padding: 4px 8px;
      color: #f4f4f6;
      background: #34343b;
      border: 1px solid #4c4c55;
      border-radius: 5px;
      font: 600 11px/1.2 system-ui, sans-serif;
      user-select: none;
    }

    #${ROOT_ID} button:hover {
      background: #4a4a54;
    }

    #${ROOT_ID} button[data-action="close"] {
      font-size: 16px;
      line-height: 13px;
      padding-inline: 7px;
    }

    #${ROOT_ID} button.hip-pinned {
      color: #101014;
      background: #8fc7ff;
      border-color: #b9dcff;
    }
  `;

  const previewImage =
    root.querySelector('.hip-image');

  const status =
    root.querySelector('.hip-status');

  const info =
    root.querySelector('.hip-info');

  const pinButton =
    root.querySelector('[data-action="pin"]');

  document.documentElement.append(style, root);

  function saveSettings() {
    GM_setValue('settings', settings);
  }

  function absoluteUrl(value) {
    if (!value || typeof value !== 'string') {
      return null;
    }

    const cleaned = value
      .trim()
      .replace(/^url\((['"]?)(.*?)\1\)$/i, '$2');

    if (!cleaned || cleaned.startsWith('#')) {
      return null;
    }

    try {
      const url = new URL(cleaned, document.baseURI);

      if (
        ['http:', 'https:', 'blob:', 'data:']
          .includes(url.protocol)
      ) {
        return url.href;
      }
    } catch (_) {
      return null;
    }

    return null;
  }

  function addUnique(array, value) {
    const url = absoluteUrl(value);

    if (url && !array.includes(url)) {
      array.push(url);
    }
  }

  function upgradedUrls(value) {
    const original = absoluteUrl(value);

    if (!original) {
      return [];
    }

    const upgraded = [];

    try {
      const url = new URL(original);
      const host = url.hostname.toLowerCase();

      if (
        /^(?:i|img)\.ytimg\.com$/.test(host) &&
        /\/vi(?:_webp)?\//.test(url.pathname)
      ) {
        const webpPath = url.pathname.replace(
          /\/(?:default|mqdefault|hqdefault|sddefault|maxresdefault)(?:_live)?\.(?:jpg|webp)$/i,
          '/maxresdefault.webp'
        );

        const jpgPath = url.pathname.replace(
          /\/(?:default|mqdefault|hqdefault|sddefault|maxresdefault)(?:_live)?\.(?:jpg|webp)$/i,
          '/maxresdefault.jpg'
        );

        if (webpPath !== url.pathname) {
          const candidate = new URL(url);
          candidate.pathname = webpPath;
          upgraded.push(candidate.href);
        }

        if (jpgPath !== url.pathname) {
          const candidate = new URL(url);
          candidate.pathname = jpgPath;
          upgraded.push(candidate.href);
        }
      }

      if (
        host === 'pbs.twimg.com' &&
        url.pathname.startsWith('/media/')
      ) {
        const candidate = new URL(url);
        candidate.searchParams.set('name', 'orig');
        upgraded.push(candidate.href);
      }
    } catch (_) {
      // Keep the original URL.
    }

    upgraded.push(original);

    return [...new Set(upgraded)];
  }

  function srcsetUrls(srcset) {
    if (!srcset) {
      return [];
    }

    return srcset
      .split(',')
      .map(part => {
        const match = part.trim().match(
          /^(\S+)(?:\s+(\d+(?:\.\d+)?)(w|x))?$/
        );

        if (!match) {
          return null;
        }

        const weight = match[2]
          ? Number(match[2]) *
            (match[3] === 'x' ? 10000 : 1)
          : 0;

        return {
          url: match[1],
          weight
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.weight - a.weight)
      .map(item => item.url);
  }

  function pointInside(element) {
    const rect = element.getBoundingClientRect();

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      pointer.x >= rect.left &&
      pointer.x <= rect.right &&
      pointer.y >= rect.top &&
      pointer.y <= rect.bottom
    );
  }

  function largeEnough(element) {
    const rect = element.getBoundingClientRect();

    return (
      Math.max(rect.width, rect.height) >=
      settings.minSizePx
    );
  }

  function usableImage(element) {
    return (
      element instanceof HTMLImageElement &&
      largeEnough(element) &&
      pointInside(element)
    );
  }

  function imageAtPointer(element) {
    const closest = element.closest?.('img');

    if (usableImage(closest)) {
      return closest;
    }

    const stack =
      document.elementsFromPoint?.(
        pointer.x,
        pointer.y
      ) || [];

    for (const stacked of stack) {
      if (usableImage(stacked)) {
        return stacked;
      }

      const shadowImage =
        stacked.shadowRoot
          ?.querySelector?.('img');

      if (usableImage(shadowImage)) {
        return shadowImage;
      }
    }

    let depth = 0;

    for (
      let node = element;
      node &&
      node !== document.body &&
      depth < 4;
      node = node.parentElement, depth += 1
    ) {
      const nearby =
        node.querySelector?.('img');

      if (usableImage(nearby)) {
        return nearby;
      }

      const shadowImage =
        node.shadowRoot
          ?.querySelector?.('img');

      if (usableImage(shadowImage)) {
        return shadowImage;
      }
    }

    return null;
  }

  function attributeUrls(element) {
    const urls = [];

    for (const name of IMAGE_ATTRIBUTES) {
      addUnique(
        urls,
        element.getAttribute?.(name)
      );
    }

    return urls;
  }

  function linkedImageUrl(element) {
    const anchor =
      element.closest?.('a[href]');

    const href =
      absoluteUrl(anchor?.href);

    return (
      href &&
      IMAGE_EXTENSION.test(href)
    ) ? href : null;
  }

  function backgroundImageUrl(element) {
    const background =
      getComputedStyle(element).backgroundImage;

    if (!background || background === 'none') {
      return null;
    }

    const match =
      background.match(
        /url\((['"]?)(.*?)\1\)/i
      );

    return match
      ? absoluteUrl(match[2])
      : null;
  }

  function candidatesForImage(
    imageElement,
    hovered
  ) {
    const rawUrls = [];

    if (settings.preferLinkedImage) {
      addUnique(
        rawUrls,
        linkedImageUrl(hovered)
      );
    }

    for (
      const url of attributeUrls(imageElement)
    ) {
      addUnique(rawUrls, url);
    }

    for (
      const url of srcsetUrls(
        imageElement.srcset
      )
    ) {
      addUnique(rawUrls, url);
    }

    const pictureSources =
      imageElement
        .closest?.('picture')
        ?.querySelectorAll?.(
          'source[srcset]'
        ) || [];

    for (const source of pictureSources) {
      for (
        const url of srcsetUrls(
          source.srcset
        )
      ) {
        addUnique(rawUrls, url);
      }
    }

    addUnique(
      rawUrls,
      imageElement.currentSrc
    );

    addUnique(
      rawUrls,
      imageElement.src
    );

    const candidates = [];

    for (const rawUrl of rawUrls) {
      for (
        const upgraded of upgradedUrls(rawUrl)
      ) {
        addUnique(candidates, upgraded);
      }
    }

    return candidates;
  }

  function findImage(element) {
    if (
      !(element instanceof Element) ||
      root.contains(element)
    ) {
      return null;
    }

    const imageElement =
      imageAtPointer(element);

    if (imageElement) {
      const candidates =
        candidatesForImage(
          imageElement,
          element
        );

      if (candidates.length) {
        return {
          candidates,
          label:
            imageElement.alt ||
            imageElement.title ||
            imageElement.getAttribute(
              'aria-label'
            ) ||
            ''
        };
      }
    }

    const linked =
      linkedImageUrl(element);

    if (linked) {
      return {
        candidates: upgradedUrls(linked),
        label: element.title || ''
      };
    }

    for (
      const attributeUrl of
      attributeUrls(element)
    ) {
      if (largeEnough(element)) {
        return {
          candidates:
            upgradedUrls(attributeUrl),
          label:
            element.getAttribute(
              'aria-label'
            ) ||
            element.title ||
            ''
        };
      }
    }

    let depth = 0;

    for (
      let node = element;
      node &&
      node !== document.documentElement &&
      node !== document.body &&
      depth < 3;
      node = node.parentElement, depth += 1
    ) {
      const backgroundUrl =
        backgroundImageUrl(node);

      if (
        backgroundUrl &&
        largeEnough(node)
      ) {
        return {
          candidates:
            upgradedUrls(backgroundUrl),
          label:
            node.getAttribute(
              'aria-label'
            ) ||
            node.title ||
            ''
        };
      }
    }

    return null;
  }

  function filenameFromUrl(url) {
    let filename = '';

    try {
      const parsed = new URL(url);

      filename = decodeURIComponent(
        parsed.pathname
          .split('/')
          .pop() ||
        ''
      );

      if (
        !/\.[a-z0-9]{2,5}$/i
          .test(filename) &&
        parsed.searchParams.get('format')
      ) {
        filename +=
          `.${parsed.searchParams.get('format')}`;
      }
    } catch (_) {
      filename = '';
    }

    filename = filename
      .replace(
        /[\\/:*?"<>|\x00-\x1F]/g,
        '_'
      )
      .slice(0, 180);

    return (
      filename &&
      /\.[a-z0-9]{2,5}$/i.test(filename)
    )
      ? filename
      : `image-${Date.now()}.jpg`;
  }

  function setInfo(media) {
    if (!settings.showCaption) {
      info.style.display = 'none';
      return;
    }

    info.style.display = '';

    const filename = currentUrl
      ? filenameFromUrl(currentUrl)
      : 'image';

    const dimensions =
      previewImage.naturalWidth &&
      previewImage.naturalHeight
        ? `${previewImage.naturalWidth}×${previewImage.naturalHeight}`
        : '';

    info.textContent = [
      media.label || filename,
      dimensions
    ]
      .filter(Boolean)
      .join(' · ');

    info.title = currentUrl || '';
  }

  function positionPreview() {
    if (
      !root.classList
        .contains('hip-visible') ||
      pinned
    ) {
      return;
    }

    const gap = 18;
    const margin = 8;
    const rect =
      root.getBoundingClientRect();

    let left = pointer.x + gap;
    let top = pointer.y + gap;

    if (
      left + rect.width >
      innerWidth - margin
    ) {
 {
      left =
        pointer.x -
        rect.width -
        gap;
    }

    if (
      top + rect.height >
      innerHeight - margin
    ) {
      top =
        pointer.y -
        rect.height -
        gap;
    }

    root.style.left =
      `${Math.max(margin, left)}px`;

    root.style.top =
      `${Math.max(margin, top)}px`;
  }

  function loadCandidate(
    media,
    index,
    thisRequest
  ) {
    if (thisRequest !== requestNumber) {
      return;
    }

    if (index >= media.candidates.length) {
      status.textContent =
        'Preview unavailable';

      status.style.display = '';
      root.style.visibility = '';

      positionPreview();
      return;
    }

    const url =
      media.candidates[index];

    previewImage.onload = () => {
      if (
        thisRequest !== requestNumber
      ) {
        return;
      }

      currentUrl = url;

      status.style.display = 'none';

      previewImage.classList.add(
        'hip-active'
      );

      setInfo(media);

      root.style.visibility = '';
      positionPreview();
    };

    previewImage.onerror = () => {
      loadCandidate(
        media,
        index + 1,
        thisRequest
      );
    };

    previewImage.src = url;
  }

  function showPreview(media, target) {
    const thisRequest = ++requestNumber;

    currentImage = media;
    currentTarget = target;
    currentUrl = null;

    previewImage.onload = null;
    previewImage.onerror = null;
    previewImage.removeAttribute('src');

    previewImage.classList.remove(
      'hip-active'
    );

    status.textContent = 'Loading…';
    status.style.display = '';

    info.textContent = '';

    root.classList.add('hip-visible');
    root.style.visibility = 'hidden';

    loadCandidate(
      media,
      0,
      thisRequest
    );

    setTimeout(() => {
      if (
        thisRequest === requestNumber &&
        root.classList
          .contains('hip-visible')
      ) {
        root.style.visibility = '';
        positionPreview();
      }
    }, 120);
  }

  function hidePreview(force = false) {
    if (pinned && !force) {
      return;
    }

    ++requestNumber;

    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);

    root.classList.remove('hip-visible');
    root.style.visibility = '';

    previewImage.onload = null;
    previewImage.onerror = null;
    previewImage.removeAttribute('src');

    previewImage.classList.remove(
      'hip-active'
    );

    currentTarget = null;
    currentImage = null;
    currentUrl = null;
  }

  function scheduleHide() {
    clearTimeout(hideTimer);

    hideTimer = setTimeout(() => {
      hidePreview();
    }, settings.hideDelayMs);
  }

  function setPinned(value) {
    pinned = value;

    pinButton.classList.toggle(
      'hip-pinned',
      pinned
    );

    pinButton.textContent =
      pinned ? 'Pinned' : 'Pin';

    if (
      !pinned &&
      !hoveredElement &&
      !root.matches(':hover')
    ) {
      scheduleHide();
    }
  }

  function fallbackDownload(
    url,
    filename
  ) {
    const anchor =
      document.createElement('a');

    anchor.href = url;
    anchor.download = filename;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';

    anchor.click();
  }

  function downloadCurrent() {
    if (!currentUrl) {
      return;
    }

    const filename =
      filenameFromUrl(currentUrl);

    try {
      GM_download({
        url: currentUrl,
        name: filename,
        saveAs: true,
        onerror: () => {
          fallbackDownload(
            currentUrl,
            filename
          );
        }
      });
    } catch (_) {
      fallbackDownload(
        currentUrl,
        filename
      );
    }
  }

  document.addEventListener(
    'pointermove',
    event => {
      pointer = {
        x: event.clientX,
        y: event.clientY
      };
    },
    {
      passive: true,
      capture: true
    }
  );

  document.addEventListener(
    'pointerover',
    event => {
      if (
        !settings.enabled ||
        pinned ||
        root.contains(event.target)
      ) {
        return;
      }

      const target = event.target;

      if (!(target instanceof Element)) {
        return;
      }

      const media = findImage(target);

      if (!media) {
        return;
      }

      hoveredElement = target;

      clearTimeout(hideTimer);
      clearTimeout(hoverTimer);

      if (currentTarget === target) {
        return;
      }

      hoverTimer = setTimeout(() => {
        if (hoveredElement === target) {
          showPreview(media, target);
        }
      }, settings.delayMs);
    },
    true
  );

  document.addEventListener(
    'pointerout',
    event => {
      if (root.contains(event.target)) {
        return;
      }

      if (
        hoveredElement &&
        (
          event.target === hoveredElement ||
          hoveredElement.contains?.(
            event.target
          )
        )
      ) {
        hoveredElement = null;

        clearTimeout(hoverTimer);
        scheduleHide();
      }
    },
    true
  );

  root.addEventListener(
    'pointerenter',
    () => {
      clearTimeout(hideTimer);
    }
  );

  root.addEventListener(
    'pointerleave',
    () => {
      if (!pinned) {
        scheduleHide();
      }
    }
  );

  root.addEventListener(
    'click',
    event => {
      const action =
        event.target
          .closest('button')
          ?.dataset.action;

      if (action === 'download') {
        downloadCurrent();
      }

      if (
        action === 'open' &&
        currentUrl
      ) {
        window.open(
          currentUrl,
          '_blank',
          'noopener,noreferrer'
        );
      }

      if (action === 'pin') {
        setPinned(!pinned);
      }

      if (action === 'close') {
        setPinned(false);
        hidePreview(true);
      }
    }
  );

  document.addEventListener(
    'keydown',
    event => {
      if (
        !root.classList
          .contains('hip-visible')
      ) {
        return;
      }

      if (event.key === 'Escape') {
        setPinned(false);
        hidePreview(true);
        return;
      }

      if (
        event.key.toLowerCase() === 'd' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        const tag =
          document.activeElement?.tagName;

        if (
          ![
            'INPUT',
            'TEXTAREA',
            'SELECT'
          ].includes(tag)
        ) {
          event.preventDefault();
          downloadCurrent();
        }
      }
    },
    true
  );

  addEventListener(
    'scroll',
    () => {
      if (!pinned) {
        hidePreview();
      }
    },
    {
      passive: true,
      capture: true
    }
  );

  addEventListener(
    'resize',
    positionPreview,
    {
      passive: true
    }
  );

  GM_registerMenuCommand(
    settings.enabled
      ? 'Disable Hover Image Preview'
      : 'Enable Hover Image Preview',
    () => {
      settings.enabled =
        !settings.enabled;

      saveSettings();
      hidePreview(true);

      alert(
        `Hover Image Preview is now ` +
        `${settings.enabled
          ? 'enabled'
          : 'disabled'}. ` +
        `Reload to update the menu label.`
      );
    }
  );

  GM_registerMenuCommand(
    'Set hover delay…',
    () => {
      const value = prompt(
        'Hover delay in milliseconds (0–3000):',
        String(settings.delayMs)
      );

      if (value === null) {
        return;
      }

      const number = Number(value);

      if (
        !Number.isFinite(number) ||
        number < 0 ||
        number > 3000
      ) {
        alert(
          'Enter a number from 0 to 3000.'
        );
        return;
      }

      settings.delayMs =
        Math.round(number);

      saveSettings();
    }
  );

  GM_registerMenuCommand(
    'Set preview maximum size…',
    () => {
      const width = prompt(
        'Maximum width as viewport percentage (20–100):',
        String(settings.maxWidthVw)
      );

      if (width === null) {
        return;
      }

      const height = prompt(
        'Maximum height as viewport percentage (20–100):',
        String(settings.maxHeightVh)
      );

      if (height === null) {
        return;
      }

      const widthNumber = Number(width);
      const heightNumber = Number(height);

      const valid =
        [widthNumber, heightNumber]
          .every(
            number =>
              Number.isFinite(number) &&
              number >= 20 &&
              number <= 100
          );

      if (!valid) {
        alert(
          'Width and height must be numbers from 20 to 100.'
        );
        return;
      }

      settings.maxWidthVw =
        Math.round(widthNumber);

      settings.maxHeightVh =
        Math.round(heightNumber);

      saveSettings();

      alert(
        'Saved. Reload the page to apply the new maximum size.'
      );
    }
  );

  GM_registerMenuCommand(
    'Reset settings',
    () => {
      Object.assign(
        settings,
        defaults
      );

      saveSettings();

      alert(
        'Settings reset. Reload the page to apply them.'
      );
    }
  );
})();

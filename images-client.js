/* Harness-QOL image presentation. Concatenate inside the Client ModuleLoader factory.
 * No runtime imports. registerImageQol(ctx, React, t) owns only public image slots.
 * t is the Harness-QOL translator; slot props.t is the conversation translator.
 */
// Layout follows the MIT-licensed @deepseek-ai/dsh-client-ui-attachment singleFit rule.
function qolImageFit(dimensions) {
  const natural = dimensions.width / dimensions.height;
  const ratio = Math.min(4, Math.max(0.25, natural));
  const box = ratio >= 1 ? { width: 240, height: 240 / ratio } : { width: 240 * ratio, height: 240 };
  const scale = Math.min(1, dimensions.width / box.width, dimensions.height / box.height);
  return {
    width: Math.max(1, Math.round(box.width * scale)),
    height: Math.max(1, Math.round(box.height * scale)),
    objectPosition: natural < 0.25 ? 'center top' : natural > 4 ? 'left center' : 'center',
  };
}

function qolImagePngBlob(image) {
  return new Promise((resolve, reject) => {
    try {
      if (!image || !image.complete || !image.naturalWidth || !image.naturalHeight) {
        throw new Error('Image has not loaded.');
      }
      const canvas = image.ownerDocument.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image conversion is unavailable.');
      context.drawImage(image, 0, 0);
      canvas.toBlob(blob => {
        canvas.width = 0;
        canvas.height = 0;
        if (blob) resolve(blob);
        else reject(new Error('Image conversion failed.'));
      }, 'image/png');
    } catch (error) {
      reject(error);
    }
  });
}

function qolCopyImage(image, environment = globalThis) {
  const clipboard = environment.navigator?.clipboard;
  const Item = environment.ClipboardItem;
  if (!clipboard?.write || typeof Item !== 'function') {
    return Promise.reject(new Error('Image clipboard is unavailable in this browser.'));
  }
  // Initiate write in the click gesture, not after decoding/conversion (Safari).
  const png = qolImagePngBlob(image);
  png.catch(() => {}); // A synchronous ClipboardItem/write failure must not orphan rejection.
  try {
    return Promise.resolve(clipboard.write([new Item({ 'image/png': png })]));
  } catch (error) {
    return Promise.reject(error);
  }
}

function registerImageQol(ctx, React, t, store) {
  const h = React.createElement;
  const css = `
.hq-img-gallery{display:flex;flex-wrap:wrap;gap:10px;max-width:100%}
.hq-img-gallery[data-align=end]{justify-content:flex-end;align-self:flex-end}
.hq-img-gallery[data-align=start]{justify-content:flex-start;align-self:flex-start}
.hq-img-frame{display:grid;place-items:center;flex:none;min-width:44px;min-height:44px;padding:0;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:zoom-in;font:inherit}
.hq-img-frame[data-variant=tile]{width:64px;height:64px;min-width:64px;min-height:64px}
.hq-img-frame img{object-fit:cover;width:100%;height:100%;display:block}
.hq-img-frame[data-variant=thumbnail]{box-sizing:border-box;width:48px;height:48px;min-width:48px;min-height:48px;padding:2px;border-radius:12px}
.hq-img-frame[data-variant=thumbnail] img{object-fit:contain}
.hq-img-frame:focus-visible,.hq-img-dialog button:focus-visible,.hq-img-full:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.hq-img-error{cursor:pointer;max-width:240px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2);font-size:12px}
.hq-img-dialog{position:fixed;inset:0;box-sizing:border-box;width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;padding:32px;border:0;background:color-mix(in srgb,var(--dsw-alias-bg-base) 88%,transparent);color:var(--dsw-alias-label-primary);overflow:hidden}
.hq-img-dialog::backdrop{background:color-mix(in srgb,var(--dsw-alias-bg-base) 88%,transparent)}
.hq-img-stage{display:flex;align-items:center;justify-content:center;width:100%;height:100%;pointer-events:none}
.hq-img-full{display:block;max-width:100%;max-height:100%;object-fit:contain;pointer-events:auto}
.hq-img-close{position:absolute;right:16px;top:16px;width:32px;height:32px;border:0;border-radius:50%;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font:24px/1 sans-serif}
.hq-img-menu{position:fixed;min-width:190px;max-width:calc(100vw - 16px);padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 6px 24px color-mix(in srgb,var(--dsw-alias-bg-base) 88%,transparent)}
.hq-img-menu button{display:block;width:100%;padding:9px 12px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}
.hq-img-menu button:hover,.hq-img-menu button:focus-visible{background:var(--dsw-alias-bg-layer-2)}
.hq-img-notice{position:absolute;left:16px;right:16px;bottom:16px;margin:0 auto;width:fit-content;max-width:calc(100% - 32px);padding:10px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:14px;overflow-wrap:anywhere}
.hq-img-notice[role=alert]{color:var(--dsw-alias-state-error-primary)}
`;

  function Lightbox({ src, label, labels, onClose, opener }) {
    const dialog = React.useRef(null);
    const image = React.useRef(null);
    const menuButton = React.useRef(null);
    const alive = React.useRef(true);
    const [menu, setMenu] = React.useState(null);
    const [notice, setNotice] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => {
      alive.current = true;
      const element = dialog.current;
      element.showModal();
      return () => {
        alive.current = false;
        element.close();
        if (opener?.isConnected) opener.focus();
      };
    }, [opener]);
    React.useLayoutEffect(() => { if (menu) menuButton.current?.focus(); }, [menu]);
    const dismissMenu = () => { setMenu(null); image.current?.focus(); };
    const openMenu = event => {
      event.preventDefault();
      event.stopPropagation();
      const bounds = image.current.getBoundingClientRect();
      const x = event.clientX || bounds.left + Math.min(bounds.width / 2, 40);
      const y = event.clientY || bounds.top + Math.min(bounds.height / 2, 40);
      setMenu({ x: Math.max(8, Math.min(x, window.innerWidth - 220)), y: Math.max(8, Math.min(y, window.innerHeight - 64)) });
    };
    const copy = () => {
      if (busy) return;
      setBusy(true);
      setNotice(null);
      qolCopyImage(image.current).then(() => {
        if (!alive.current) return;
        setMenu(null);
        setNotice({ error: false, text: t('image.copied') });
        image.current?.focus();
      }, error => {
        if (!alive.current) return;
        setMenu(null);
        setNotice({ error: true, text: `${t('image.copyFailed')} ${error instanceof Error ? error.message : String(error)}` });
        image.current?.focus();
      }).finally(() => { if (alive.current) setBusy(false); });
    };
    return h('dialog', {
      ref: dialog, className: 'hq-img-dialog', 'aria-label': labels.dialog,
      onCancel: event => { event.preventDefault(); event.stopPropagation(); if (menu) dismissMenu(); else onClose(); },
      onKeyDown: event => {
        if (event.key === 'Escape') {
          // Keep the application-wide Esc/Esc turn-cancel shortcut out of this modal.
          event.stopPropagation();
          if (menu) { event.preventDefault(); dismissMenu(); }
          // With no menu, retain the native dialog cancel/close behavior.
        } else if (menu && ['Tab', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); menuButton.current?.focus(); }
      },
      onKeyUp: event => { if (event.key === 'Escape') event.stopPropagation(); },
      onClick: event => {
        if (menu) { dismissMenu(); return; }
        if (event.target === event.currentTarget) onClose();
      },
    },
    h('div', { className: 'hq-img-stage' }, h('img', {
      ref: image, className: 'hq-img-full', src, alt: label, tabIndex: 0,
      onContextMenu: openMenu,
      onKeyDown: event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openMenu(event);
      },
    })),
    h('button', { className: 'hq-img-close', type: 'button', title: labels.close, 'aria-label': labels.close, onClick: event => { event.stopPropagation(); onClose(); } }, '×'),
    menu && h('div', { className: 'hq-img-menu', role: 'menu', 'aria-label': t('image.menu'), style: { left: menu.x, top: menu.y }, onClick: event => event.stopPropagation(), onContextMenu: event => event.preventDefault() },
      h('button', { ref: menuButton, type: 'button', role: 'menuitem', 'aria-disabled': busy, onClick: copy }, busy ? t('image.copying') : t('image.copy'))),
    notice && h('div', { className: 'hq-img-notice', role: notice.error ? 'alert' : 'status' }, notice.text));
  }

  function ImageEntry({ image, loadImage, variant, labels }) {
    const preview = image.preview;
    const attachment = image.attachment;
    const button = React.useRef(null);
    const [loaded, setLoaded] = React.useState(() => attachment ? loadImage.peek?.(attachment) ?? null : null);
    const [failed, setFailed] = React.useState(false);
    const [attempt, setAttempt] = React.useState(0);
    const [open, setOpen] = React.useState(false);
    React.useEffect(() => {
      if (!attachment) return;
      let live = true;
      setFailed(false);
      setLoaded(loadImage.peek?.(attachment) ?? null);
      Promise.resolve().then(() => loadImage(attachment)).then(url => { if (live) setLoaded(url); }, () => { if (live) setFailed(true); });
      return () => { live = false; };
    }, [attachment, loadImage, attempt]);
    const src = preview?.url ?? loaded;
    const label = image.label ?? preview?.name ?? attachment?.name ?? labels.image;
    const dimensions = attachment ?? (preview?.width && preview?.height ? preview : null);
    const fit = variant === 'single' ? (dimensions ? qolImageFit(dimensions) : { width: 240, height: 240, objectPosition: 'center' }) : undefined;
    if (failed) return h('button', {
      type: 'button', className: 'hq-img-frame hq-img-error', 'data-variant': variant,
      title: labels.loadFailed, 'aria-label': labels.loadFailed,
      onClick: () => setAttempt(value => value + 1),
    }, variant === 'thumbnail' ? '↻' : labels.loadFailed);
    return h(React.Fragment, null,
      h('button', {
        ref: button, type: 'button', className: 'hq-img-frame', 'data-variant': variant,
        style: fit ? { width: fit.width, height: fit.height } : undefined,
        title: src ? labels.open : labels.loading,
        'aria-label': src ? labels.openNamed(label) : labels.loading,
        'aria-busy': !src || undefined,
        onClick: () => { if (src) setOpen(true); },
      }, src ? h('img', { src, alt: label, style: fit ? { objectPosition: fit.objectPosition } : undefined }) : h('span', null, variant === 'thumbnail' ? '…' : labels.loading)),
      open && src && h(Lightbox, { src, label, labels: labels.lightbox, onClose: () => setOpen(false), opener: button.current }));
  }

  function Images(props) {
    if (store && !store.isEnabled('images')) return null;
    const { images, loadImage, align, compact = false, thumbnail = false } = props;
    const ct = props.t;
    const labels = props.labels ?? {
      image: ct('image.label'), open: ct('image.openOriginal'),
      openNamed: label => ct('image.openOriginalLabel', { label }),
      loading: ct('image.loading'), loadFailed: ct('image.loadFailed'),
      lightbox: { dialog: ct('image.preview'), close: ct('image.closePreview') },
    };
    if (!images.length) return null;
    const variant = thumbnail ? 'thumbnail' : compact || images.length > 1 ? 'tile' : 'single';
    return h(React.Fragment, null, h('style', null, css),
      h('div', { className: 'hq-img-gallery', 'data-align': align }, images.map((image, index) => h(ImageEntry, {
        key: `${image.attachment?.attachmentId ?? image.preview?.url}:${index}`,
        image, loadImage, variant, labels,
      }))));
  }

  let disposers = [];
  function update() {
    const enabled = !store || store.isEnabled('images');
    if (enabled && disposers.length === 0) {
      disposers = [
        'conversation.chat.user.images', 'conversation.chat.message.images',
        'conversation.trajectory.images', 'tool.call.images',
      ].map(name => ctx.slots.inject(name, () => ctx.slots.register({ name, priority: 0, locale: 'conversation' }, Images)));
    } else if (!enabled && disposers.length > 0) {
      for (const dispose of disposers.reverse()) dispose();
      disposers = [];
    }
  }

  update();
  const unsub = store?.subscribe ? store.subscribe(update) : null;
  return () => {
    if (unsub) unsub();
    for (const dispose of disposers.reverse()) dispose();
    disposers = [];
  };
}

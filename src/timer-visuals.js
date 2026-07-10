(function initGuruTimeVisuals(factory) {
  const visuals = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = visuals;
  }

  if (typeof window !== 'undefined') {
    window.GuruTimeVisuals = visuals;

    const mount = () => visuals.mountTimerOverlay(document, window);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
      mount();
    }
  }
})(function createGuruTimeVisuals() {
  'use strict';

  const TIME_THEMES = Object.freeze({
    indigo: Object.freeze({ name: 'indigo', color: '#7771E8' }),
    amber: Object.freeze({ name: 'amber', color: '#D8872F' }),
    cobalt: Object.freeze({ name: 'cobalt', color: '#3F78D8' }),
    coral: Object.freeze({ name: 'coral', color: '#D86455' }),
  });

  const CATEGORY_LABELS = Object.freeze({
    important: 'Önemli',
    later: 'Bir Ara',
    today: 'Bugün',
  });

  const CAPSULE_WIDTH = 112;
  const CAPSULE_HEIGHT = 78;
  const DIALOG_WIDTH = 320;
  const DIALOG_GAP = 14;
  const VIEWPORT_MARGIN = 12;

  function clamp(value, min, max) {
    if (max < min) return min;
    return Math.min(max, Math.max(min, value));
  }

  function asDate(fireAt) {
    if (fireAt instanceof Date) return fireAt;
    return new Date(Number(fireAt));
  }

  function isValidDate(date) {
    return date instanceof Date && Number.isFinite(date.getTime());
  }

  function normalizeMinutes(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return clamp(Math.round(parsed), 1, 1440);
  }

  function getTimeTheme(fireAt) {
    const date = asDate(fireAt);
    const hour = isValidDate(date) ? date.getHours() : 12;

    if (hour >= 22 || hour < 6) return TIME_THEMES.indigo;
    if (hour < 12) return TIME_THEMES.amber;
    if (hour < 18) return TIME_THEMES.cobalt;
    return TIME_THEMES.coral;
  }

  function formatLocalTime(fireAt) {
    const date = asDate(fireAt);
    if (!isValidDate(date)) return '--:--';
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  function formatDurationShort(value) {
    const minutes = normalizeMinutes(value);
    if (minutes === 0) return '0 dk sonra';

    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    if (hours && remainder) return `${hours} sa ${remainder} dk sonra`;
    if (hours) return `${hours} sa sonra`;
    return `${minutes} dk sonra`;
  }

  function formatDurationLong(value) {
    const minutes = normalizeMinutes(value);
    if (minutes === 0) return '0 dakika sonra';

    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    if (hours && remainder) return `${hours} saat ${remainder} dakika sonra`;
    if (hours) return `${hours} saat sonra`;
    return `${minutes} dakika sonra`;
  }

  function computeCapsuleRect({
    endpointX,
    endpointY,
    viewportWidth,
    viewportHeight,
    capsuleWidth = CAPSULE_WIDTH,
    capsuleHeight = CAPSULE_HEIGHT,
    margin = VIEWPORT_MARGIN,
  }) {
    const width = Math.max(1, Number(viewportWidth) || 1);
    const height = Math.max(1, Number(viewportHeight) || 1);
    const safeX = Number.isFinite(Number(endpointX)) ? Number(endpointX) : width / 2;
    const safeY = Number.isFinite(Number(endpointY)) ? Number(endpointY) : height / 2;
    const left = clamp(safeX - capsuleWidth / 2, margin, width - capsuleWidth - margin);
    const top = clamp(safeY - capsuleHeight / 2, margin, height - capsuleHeight - margin);

    return {
      left,
      top,
      right: left + capsuleWidth,
      bottom: top + capsuleHeight,
      centerX: left + capsuleWidth / 2,
      centerY: top + capsuleHeight / 2,
      width: capsuleWidth,
      height: capsuleHeight,
    };
  }

  function computeDialogPosition({
    endpointX,
    endpointY,
    viewportWidth,
    viewportHeight,
    dialogWidth = DIALOG_WIDTH,
    dialogHeight,
    capsuleWidth = CAPSULE_WIDTH,
    capsuleHeight = CAPSULE_HEIGHT,
    gap = DIALOG_GAP,
    margin = VIEWPORT_MARGIN,
  }) {
    const width = Math.max(1, Number(viewportWidth) || 1);
    const height = Math.max(1, Number(viewportHeight) || 1);
    const measuredHeight = Math.max(1, Number(dialogHeight) || 1);
    const actualWidth = Math.min(Math.max(1, Number(dialogWidth) || 1), Math.max(1, width - margin * 2));
    const capsule = computeCapsuleRect({
      endpointX,
      endpointY,
      viewportWidth: width,
      viewportHeight: height,
      capsuleWidth,
      capsuleHeight,
      margin,
    });

    const left = clamp(capsule.centerX - actualWidth / 2, margin, width - actualWidth - margin);
    const belowTop = capsule.bottom + gap;
    const aboveTop = capsule.top - gap - measuredHeight;
    const belowFits = belowTop + measuredHeight <= height - margin;
    const aboveFits = aboveTop >= margin;

    if (belowFits) {
      return { left, top: belowTop, placement: 'below', width: actualWidth };
    }

    if (aboveFits) {
      return { left, top: aboveTop, placement: 'above', width: actualWidth };
    }

    const availableBelow = height - margin - belowTop;
    const availableAbove = capsule.top - gap - margin;
    const preferredTop = availableBelow >= availableAbove ? belowTop : aboveTop;
    return {
      left,
      top: clamp(preferredTop, margin, height - measuredHeight - margin),
      placement: availableBelow >= availableAbove ? 'below' : 'above',
      width: actualWidth,
    };
  }

  function interpolateRopePoints(anchor, endpoint, segments) {
    const count = Math.max(1, Math.round(Number(segments) || 1));
    const startX = Number(anchor && anchor.x) || 0;
    const startY = Number(anchor && anchor.y) || 0;
    const endX = Number(endpoint && endpoint.x) || 0;
    const endY = Number(endpoint && endpoint.y) || 0;

    return Array.from({ length: count + 1 }, (_, index) => {
      const progress = index / count;
      return {
        x: startX + (endX - startX) * progress,
        y: startY + (endY - startY) * progress,
      };
    });
  }

  function mountTimerOverlay(doc, win) {
    if (!doc || !win || doc.documentElement.dataset.timerOverlayMounted === 'true') return null;

    const canvas = doc.getElementById('ropeCanvas');
    const capsule = doc.getElementById('timeCapsule');
    const capsuleTime = doc.getElementById('capsuleTime');
    const capsuleDuration = doc.getElementById('capsuleDuration');
    const dialog = doc.getElementById('confirmation');
    const form = doc.getElementById('timerForm');
    const dialogTime = doc.getElementById('dialogTime');
    const input = doc.getElementById('taskInput');
    const categoryList = doc.getElementById('categoryList');
    const cancelButton = doc.getElementById('cancelButton');
    const confirmButton = doc.getElementById('confirmButton');
    const formError = doc.getElementById('formError');
    const liveRegion = doc.getElementById('timerLive');

    if (!canvas || !capsule || !dialog || !form || !input) return null;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    doc.documentElement.dataset.timerOverlayMounted = 'true';

    const api = win.guruTime && win.guruTime.overlay;
    const reducedMotionQuery = typeof win.matchMedia === 'function'
      ? win.matchMedia('(prefers-reduced-motion: reduce)')
      : { matches: false };
    const highContrastQuery = typeof win.matchMedia === 'function'
      ? win.matchMedia('(prefers-contrast: more)')
      : { matches: false };

    const SEGMENTS = 22;
    const GRAVITY = 0.34;
    const DAMPING = 0.965;
    const CONSTRAINT_ITERATIONS = 9;

    const state = {
      width: 1,
      height: 1,
      dpr: 1,
      anchorX: 0,
      anchorY: 0,
      endpointX: 0,
      endpointY: 0,
      points: [],
      segmentLength: 8,
      dragging: false,
      released: false,
      minutes: 0,
      fireAt: 0,
      category: 'today',
      lastAnnouncement: '',
      animationFrame: 0,
      busy: false,
    };

    function announce(message) {
      const text = String(message || '').trim();
      if (!text || text === state.lastAnnouncement) return;
      state.lastAnnouncement = text;
      if (liveRegion) liveRegion.textContent = text;
    }

    function resizeCanvas() {
      state.dpr = Math.max(1, Number(win.devicePixelRatio) || 1);
      state.width = Math.max(1, win.innerWidth);
      state.height = Math.max(1, win.innerHeight);
      canvas.width = Math.round(state.width * state.dpr);
      canvas.height = Math.round(state.height * state.dpr);
      canvas.style.width = `${state.width}px`;
      canvas.style.height = `${state.height}px`;
      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

      if (state.minutes > 0) {
        setEndpoint(state.endpointX, state.endpointY);
        renderCapsule();
      }

      if (!dialog.hidden) placeDialog();
    }

    function initRope() {
      const start = { x: state.anchorX, y: state.anchorY };
      const end = { x: state.endpointX || state.anchorX, y: state.endpointY || state.anchorY + 120 };
      state.points = interpolateRopePoints(start, end, SEGMENTS).map((point, index) => ({
        x: point.x,
        y: point.y,
        oldX: point.x,
        oldY: point.y,
        pinned: index === 0 || index === SEGMENTS,
      }));
    }

    function setEndpoint(rawX, rawY) {
      const rect = computeCapsuleRect({
        endpointX: rawX,
        endpointY: rawY,
        viewportWidth: state.width,
        viewportHeight: state.height,
      });

      state.endpointX = rect.centerX;
      state.endpointY = rect.centerY;

      if (state.points.length === 0) initRope();
      const end = state.points[state.points.length - 1];
      end.x = state.endpointX;
      end.y = state.endpointY;
      end.oldX = state.endpointX;
      end.oldY = state.endpointY;
      end.pinned = true;

      const distance = Math.hypot(state.endpointX - state.anchorX, state.endpointY - state.anchorY);
      state.segmentLength = Math.max(4, (distance / SEGMENTS) * 1.012);
      return rect;
    }

    function updatePhysics() {
      if (state.points.length < 2 || (!state.dragging && !state.released)) return;

      if (reducedMotionQuery.matches) {
        const straight = interpolateRopePoints(
          { x: state.anchorX, y: state.anchorY },
          { x: state.endpointX, y: state.endpointY },
          SEGMENTS,
        );
        state.points.forEach((point, index) => {
          point.x = straight[index].x;
          point.y = straight[index].y;
          point.oldX = point.x;
          point.oldY = point.y;
        });
        return;
      }

      state.points.forEach((point) => {
        if (point.pinned) return;
        const velocityX = (point.x - point.oldX) * DAMPING;
        const velocityY = (point.y - point.oldY) * DAMPING;
        point.oldX = point.x;
        point.oldY = point.y;
        point.x += velocityX;
        point.y += velocityY + GRAVITY;
      });

      const first = state.points[0];
      first.x = state.anchorX;
      first.y = state.anchorY;
      const last = state.points[state.points.length - 1];
      last.x = state.endpointX;
      last.y = state.endpointY;

      for (let iteration = 0; iteration < CONSTRAINT_ITERATIONS; iteration += 1) {
        for (let index = 0; index < state.points.length - 1; index += 1) {
          const a = state.points[index];
          const b = state.points[index + 1];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distance = Math.hypot(dx, dy) || 1;
          const correction = (distance - state.segmentLength) / distance;
          const offsetX = dx * correction;
          const offsetY = dy * correction;

          if (!a.pinned && !b.pinned) {
            a.x += offsetX * 0.5;
            a.y += offsetY * 0.5;
            b.x -= offsetX * 0.5;
            b.y -= offsetY * 0.5;
          } else if (!a.pinned) {
            a.x += offsetX;
            a.y += offsetY;
          } else if (!b.pinned) {
            b.x -= offsetX;
            b.y -= offsetY;
          }
        }
      }
    }

    function traceRope() {
      const points = state.points;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);

      for (let index = 1; index < points.length - 1; index += 1) {
        const point = points[index];
        const next = points[index + 1];
        ctx.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
      }

      const end = points[points.length - 1];
      ctx.lineTo(end.x, end.y);
    }

    function drawRope() {
      ctx.clearRect(0, 0, state.width, state.height);
      if (state.points.length < 2 || state.minutes <= 0 || (!state.dragging && !state.released)) return;

      const theme = getTimeTheme(state.fireAt);
      const contrast = Boolean(highContrastQuery.matches);

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      traceRope();
      ctx.strokeStyle = contrast ? 'rgba(12, 15, 20, 0.88)' : 'rgba(13, 18, 27, 0.25)';
      ctx.lineWidth = contrast ? 9 : 7;
      ctx.shadowColor = 'rgba(8, 12, 19, 0.22)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 3;
      ctx.stroke();

      traceRope();
      ctx.strokeStyle = theme.color;
      ctx.lineWidth = contrast ? 5.5 : 4.2;
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.stroke();

      traceRope();
      ctx.strokeStyle = contrast ? 'rgba(255, 255, 255, 0.72)' : 'rgba(255, 255, 255, 0.38)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    function renderCapsule() {
      if (state.minutes <= 0 || (!state.dragging && !state.released)) {
        capsule.classList.remove('is-visible');
        return;
      }

      const rect = computeCapsuleRect({
        endpointX: state.endpointX,
        endpointY: state.endpointY,
        viewportWidth: state.width,
        viewportHeight: state.height,
      });
      const theme = getTimeTheme(state.fireAt);
      doc.documentElement.style.setProperty('--accent', theme.color);
      capsule.style.setProperty('--capsule-x', `${rect.left}px`);
      capsule.style.setProperty('--capsule-y', `${rect.top}px`);
      capsule.dataset.timeTheme = theme.name;
      capsuleTime.textContent = formatLocalTime(state.fireAt);
      capsuleDuration.textContent = formatDurationShort(state.minutes);
      capsule.classList.add('is-visible');

      if (state.dragging) {
        announce(`${formatDurationLong(state.minutes)}, saat ${formatLocalTime(state.fireAt)}`);
      }
    }

    function animate() {
      updatePhysics();
      drawRope();
      state.animationFrame = win.requestAnimationFrame(animate);
    }

    function renderCategoryChoice() {
      categoryList.querySelectorAll('[data-category]').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.category === state.category));
      });
    }

    function placeDialog() {
      if (dialog.hidden) return;
      const measuredHeight = Math.max(1, dialog.getBoundingClientRect().height);
      const position = computeDialogPosition({
        endpointX: state.endpointX,
        endpointY: state.endpointY,
        viewportWidth: state.width,
        viewportHeight: state.height,
        dialogHeight: measuredHeight,
      });

      dialog.style.left = `${position.left}px`;
      dialog.style.top = `${position.top}px`;
      dialog.dataset.placement = position.placement;
    }

    function showDialog() {
      state.category = 'today';
      state.busy = false;
      input.value = '';
      input.removeAttribute('aria-invalid');
      formError.textContent = '';
      confirmButton.disabled = false;
      dialogTime.textContent = `${formatLocalTime(state.fireAt)} için, ${formatDurationLong(state.minutes)}`;
      renderCategoryChoice();

      dialog.hidden = false;
      dialog.classList.add('is-measuring');
      win.requestAnimationFrame(() => {
        placeDialog();
        dialog.classList.remove('is-measuring');
        input.focus({ preventScroll: true });
        announce(`Hatırlatma adı girin. Alarm ${formatDurationLong(state.minutes)} çalacak.`);
      });
    }

    function getFocusableElements() {
      return Array.from(dialog.querySelectorAll('button:not([disabled]), input:not([disabled])'))
        .filter((element) => element.getClientRects().length > 0);
    }

    function handleFocusTrap(event) {
      if (event.key !== 'Tab' || dialog.hidden) return;
      const focusable = getFocusableElements();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && doc.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && doc.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function cancel() {
      if (state.busy) return;
      if (api && typeof api.cancel === 'function') api.cancel();
    }

    async function submit(event) {
      event.preventDefault();
      if (state.busy) return;

      const title = input.value.replace(/\s+/g, ' ').trim();
      if (!title) {
        input.setAttribute('aria-invalid', 'true');
        formError.textContent = 'Hatırlatma adını yazın.';
        announce(formError.textContent);
        input.focus();
        return;
      }

      if (!Number.isFinite(state.fireAt) || state.fireAt <= Date.now()) {
        formError.textContent = 'Seçilen saat geçti. Halatı yeniden çekin.';
        announce(formError.textContent);
        return;
      }

      input.removeAttribute('aria-invalid');
      formError.textContent = '';
      state.busy = true;
      confirmButton.disabled = true;
      announce('Alarm kuruluyor.');

      try {
        if (!api || typeof api.confirm !== 'function') throw new Error('Timer API is unavailable');
        await Promise.resolve(api.confirm({
          title,
          minutes: state.minutes,
          category: state.category,
          fireAt: state.fireAt,
        }));
      } catch (error) {
        state.busy = false;
        confirmButton.disabled = false;
        formError.textContent = 'Alarm kurulamadı. Yeniden deneyin.';
        announce(formError.textContent);
      }
    }

    function handleTimerUpdate(payload) {
      const data = payload || {};
      state.dragging = true;
      state.released = false;
      state.minutes = normalizeMinutes(data.minutes);
      state.fireAt = Number.isFinite(Number(data.fireAt))
        ? Number(data.fireAt)
        : Date.now() + state.minutes * 60 * 1000;

      setEndpoint(Number(data.cursorXScreen), Number(data.cursorYScreen));
      renderCapsule();
    }

    function handleTimerRelease(payload) {
      const data = payload || {};
      state.minutes = normalizeMinutes(data.minutes || state.minutes);
      state.fireAt = Number.isFinite(Number(data.fireAt))
        ? Number(data.fireAt)
        : Date.now() + state.minutes * 60 * 1000;
      state.dragging = false;
      state.released = state.minutes > 0;

      if (state.points.length > 0) {
        const end = state.points[state.points.length - 1];
        end.pinned = true;
        end.x = state.endpointX;
        end.y = state.endpointY;
        end.oldX = state.endpointX;
        end.oldY = state.endpointY;
      }

      if (state.minutes <= 0) {
        capsule.classList.remove('is-visible');
        cancel();
        return;
      }

      renderCapsule();
      showDialog();
    }

    form.addEventListener('submit', submit);
    cancelButton.addEventListener('click', cancel);
    categoryList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-category]');
      if (!button || !CATEGORY_LABELS[button.dataset.category]) return;
      state.category = button.dataset.category;
      renderCategoryChoice();
    });
    input.addEventListener('input', () => {
      if (input.value.trim()) {
        input.removeAttribute('aria-invalid');
        formError.textContent = '';
      }
    });
    doc.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
        return;
      }
      handleFocusTrap(event);
    });
    win.addEventListener('resize', resizeCanvas);

    const unsubscribers = [];
    if (api) {
      if (typeof api.onInitAnchor === 'function') {
        const unsubscribe = api.onInitAnchor((payload) => {
          const data = payload || {};
          state.anchorX = Number.isFinite(Number(data.x)) ? Number(data.x) : state.width / 2;
          state.anchorY = Number.isFinite(Number(data.y)) ? Number(data.y) : 0;
          state.endpointX = state.anchorX;
          state.endpointY = Math.max(48, state.anchorY + 120);
          initRope();
        });
        if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe);
      }
      if (typeof api.onTimerUpdate === 'function') {
        const unsubscribe = api.onTimerUpdate(handleTimerUpdate);
        if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe);
      }
      if (typeof api.onTimerRelease === 'function') {
        const unsubscribe = api.onTimerRelease(handleTimerRelease);
        if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe);
      }
    } else {
      announce('Zamanlayıcı bağlantısı kurulamadı.');
    }

    resizeCanvas();
    initRope();
    animate();

    win.addEventListener('beforeunload', () => {
      win.cancelAnimationFrame(state.animationFrame);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    }, { once: true });

    return {
      state,
      handleTimerUpdate,
      handleTimerRelease,
      placeDialog,
    };
  }

  return Object.freeze({
    TIME_THEMES,
    clamp,
    normalizeMinutes,
    getTimeTheme,
    formatLocalTime,
    formatDurationShort,
    formatDurationLong,
    computeCapsuleRect,
    computeDialogPosition,
    interpolateRopePoints,
    mountTimerOverlay,
  });
});

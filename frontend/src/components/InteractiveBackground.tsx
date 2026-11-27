import { useEffect, useRef } from 'react';

type Kind = 'node' | 'clover' | 'glyph';

interface Particle {
  kind: Kind;
  x: number;
  y: number;
  /** Constant drift */
  vx: number;
  vy: number;
  /** Extra velocity from the mouse, which fades out */
  px: number;
  py: number;
  size: number;
  /** 0 is far away, 1 is close; used for parallax */
  depth: number;
  angle: number;
  spin: number;
  phase: number;
  color: string;
  glyph: string;
}

interface Ripple {
  x: number;
  y: number;
  radius: number;
}

const COLORS = ['#79b856', '#4f9b50', '#c9d9b2', '#d7b84b'];
const GLYPHS = ['0x1F', '{ }', '</>', '01', '#!', '$_', 'FLAG', '&&'];
const LINK_DISTANCE = 130;
const MOUSE_LINK_DISTANCE = 210;
const MOUSE_PUSH_DISTANCE = 140;
const RIPPLE_MAX_RADIUS = 320;

const random = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];

function createParticle(width: number, height: number): Particle {
  const roll = Math.random();
  const kind: Kind = roll < 0.68 ? 'node' : roll < 0.86 ? 'clover' : 'glyph';
  // Place more particles towards the left and right edges
  const u = Math.random();
  const x = u < 0.5
    ? 0.5 * Math.pow(2 * u, 1.6) * width
    : (1 - 0.5 * Math.pow(2 * (1 - u), 1.6)) * width;

  return {
    kind,
    x,
    y: Math.random() * height,
    vx: random(-0.35, 0.35),
    vy: random(-0.45, -0.08),
    px: 0,
    py: 0,
    size: kind === 'clover' ? random(7, 17) : kind === 'glyph' ? random(10, 15) : random(1.2, 2.8),
    depth: Math.random(),
    angle: random(0, Math.PI * 2),
    spin: random(-0.008, 0.008),
    phase: random(0, Math.PI * 2),
    color: pick(COLORS),
    glyph: pick(GLYPHS),
  };
}

function drawClover(context: CanvasRenderingContext2D, size: number) {
  context.beginPath();
  for (let leaf = 0; leaf < 4; leaf += 1) {
    context.rotate(Math.PI / 2);
    context.moveTo(0, 0);
    context.bezierCurveTo(-size * 0.15, -size * 0.3, -size * 0.65, -size * 0.45, -size * 0.6, -size * 0.85);
    context.bezierCurveTo(-size * 0.55, -size * 1.2, -size * 0.1, -size * 1.15, 0, -size * 0.9);
    context.bezierCurveTo(size * 0.1, -size * 1.15, size * 0.55, -size * 1.2, size * 0.6, -size * 0.85);
    context.bezierCurveTo(size * 0.65, -size * 0.45, size * 0.15, -size * 0.3, 0, 0);
  }
  context.fill();
}

/**
 * Animated canvas layer that reacts to the mouse. Place it inside a positioned
 * parent, before the content; the content needs a higher z-index.
 */
export default function InteractiveBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return undefined;

    // The site forces pointer-events on every element, so override it here
    canvas.style.setProperty('pointer-events', 'none', 'important');

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const mouse = { x: 0, y: 0, active: false };
    const parallax = { x: 0, y: 0 };
    let particles: Particle[] = [];
    let ripples: Ripple[] = [];
    let width = 0;
    let height = 0;
    let frame = 0;
    let lastTime = 0;

    const resize = () => {
      const oldWidth = width;
      const oldHeight = height;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      const count = Math.min(130, Math.round((width * height) / 12000));
      if (oldWidth && oldHeight) {
        particles.forEach((p) => {
          p.x *= width / oldWidth;
          p.y *= height / oldHeight;
        });
      }
      particles = particles.slice(0, count);
      while (particles.length < count) particles.push(createParticle(width, height));
    };

    // Dimmer behind the middle of the page so the content stays readable
    const visibility = (x: number) => {
      const fromCenter = Math.abs(x - width / 2) / (width / 2 || 1);
      const t = Math.min(1, Math.max(0, (fromCenter - 0.25) / 0.5));
      return 0.3 + 0.7 * t * t * (3 - 2 * t);
    };

    const update = (step: number) => {
      const targetX = mouse.active ? mouse.x - width / 2 : 0;
      const targetY = mouse.active ? mouse.y - height / 2 : 0;
      parallax.x += (targetX - parallax.x) * 0.05 * step;
      parallax.y += (targetY - parallax.y) * 0.05 * step;

      ripples.forEach((ripple) => { ripple.radius += 7 * step; });
      ripples = ripples.filter((ripple) => ripple.radius < RIPPLE_MAX_RADIUS);

      particles.forEach((p) => {
        let nearness = 0;
        if (mouse.active) {
          const dx = p.x - mouse.x;
          const dy = p.y - mouse.y;
          const distance = Math.hypot(dx, dy) || 1;
          if (distance < MOUSE_PUSH_DISTANCE) {
            nearness = 1 - distance / MOUSE_PUSH_DISTANCE;
            p.px += (dx / distance) * nearness * 0.55 * step;
            p.py += (dy / distance) * nearness * 0.55 * step;
          }
        }

        ripples.forEach((ripple) => {
          const dx = p.x - ripple.x;
          const dy = p.y - ripple.y;
          const distance = Math.hypot(dx, dy) || 1;
          if (Math.abs(distance - ripple.radius) < 18) {
            const force = (1 - ripple.radius / RIPPLE_MAX_RADIUS) * 1.8 * step;
            p.px += (dx / distance) * force;
            p.py += (dy / distance) * force;
          }
        });

        const friction = Math.pow(0.93, step);
        p.px *= friction;
        p.py *= friction;
        p.x += (p.vx + p.px) * step;
        p.y += (p.vy + p.py) * step;
        p.angle += (p.spin + nearness * 0.12) * step;
        p.phase += 0.025 * step;

        const margin = 30;
        if (p.x < -margin) p.x = width + margin;
        if (p.x > width + margin) p.x = -margin;
        if (p.y < -margin) p.y = height + margin;
        if (p.y > height + margin) p.y = -margin;
      });
    };

    const draw = () => {
      context.clearRect(0, 0, width, height);

      const points = particles.map((p) => ({
        p,
        x: p.x - parallax.x * p.depth * 0.035,
        y: p.y - parallax.y * p.depth * 0.035,
      }));

      if (mouse.active) {
        const glow = context.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, 190);
        glow.addColorStop(0, 'rgba(121, 184, 86, 0.2)');
        glow.addColorStop(1, 'rgba(121, 184, 86, 0)');
        context.fillStyle = glow;
        context.fillRect(mouse.x - 190, mouse.y - 190, 380, 380);
      }

      context.lineWidth = 1;
      const nodes = points.filter(({ p }) => p.kind === 'node');
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const distance = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
          if (distance < LINK_DISTANCE) {
            const middle = (nodes[i].x + nodes[j].x) / 2;
            context.globalAlpha = (1 - distance / LINK_DISTANCE) * 0.35 * visibility(middle);
            context.strokeStyle = '#79b856';
            context.beginPath();
            context.moveTo(nodes[i].x, nodes[i].y);
            context.lineTo(nodes[j].x, nodes[j].y);
            context.stroke();
          }
        }
      }

      points.forEach(({ p, x, y }) => {
        let boost = 0;
        if (mouse.active) {
          const distance = Math.hypot(x - mouse.x, y - mouse.y);
          if (distance < MOUSE_LINK_DISTANCE) {
            boost = 1 - distance / MOUSE_LINK_DISTANCE;
            context.globalAlpha = boost * 0.6;
            context.strokeStyle = '#d7b84b';
            context.beginPath();
            context.moveTo(mouse.x, mouse.y);
            context.lineTo(x, y);
            context.stroke();
          }
        }

        const pulse = 0.8 + 0.2 * Math.sin(p.phase);
        const base = p.kind === 'node' ? 0.8 : 0.5;
        context.globalAlpha = Math.min(1, base * pulse * visibility(x) + boost * 0.5);
        context.fillStyle = p.color;

        if (p.kind === 'node') {
          context.beginPath();
          context.arc(x, y, p.size * (1 + boost), 0, Math.PI * 2);
          context.fill();
        } else if (p.kind === 'clover') {
          context.save();
          context.translate(x, y);
          context.rotate(p.angle);
          drawClover(context, p.size * (pulse + boost * 0.6));
          context.restore();
        } else {
          context.font = `600 ${p.size + boost * 4}px ui-monospace, monospace`;
          context.textAlign = 'center';
          context.fillText(p.glyph, x, y);
        }
      });

      context.lineWidth = 2;
      context.strokeStyle = '#c9d9b2';
      ripples.forEach((ripple) => {
        context.globalAlpha = (1 - ripple.radius / RIPPLE_MAX_RADIUS) * 0.7;
        context.beginPath();
        context.arc(ripple.x, ripple.y, ripple.radius, 0, Math.PI * 2);
        context.stroke();
      });
      context.globalAlpha = 1;
    };

    const animate = (time: number) => {
      // Steps are measured in 60fps frames so speed matches on any screen
      const step = lastTime ? Math.min((time - lastTime) / (1000 / 60), 3) : 1;
      lastTime = time;
      update(step);
      draw();
      frame = requestAnimationFrame(animate);
    };

    const setMouse = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = event.clientX - rect.left;
      mouse.y = event.clientY - rect.top;
      mouse.active = true;
    };
    const handlePointerDown = (event: PointerEvent) => {
      setMouse(event);
      ripples.push({ x: mouse.x, y: mouse.y, radius: 0 });
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') mouse.active = false;
    };
    const clearMouse = () => { mouse.active = false; };

    const handleResize = () => {
      resize();
      if (reducedMotion) draw();
    };

    resize();
    window.addEventListener('resize', handleResize);

    if (reducedMotion) {
      draw();
    } else {
      window.addEventListener('pointermove', setMouse, { passive: true });
      window.addEventListener('pointerdown', handlePointerDown, { passive: true });
      window.addEventListener('pointerup', handlePointerUp, { passive: true });
      window.addEventListener('pointercancel', clearMouse);
      window.addEventListener('blur', clearMouse);
      document.documentElement.addEventListener('pointerleave', clearMouse);
      frame = requestAnimationFrame(animate);
    }

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('pointermove', setMouse);
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', clearMouse);
      window.removeEventListener('blur', clearMouse);
      document.documentElement.removeEventListener('pointerleave', clearMouse);
    };
  }, []);

  // clip-path keeps the fixed canvas inside the parent, so it never covers the footer
  return (
    <div
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, zIndex: 0, clipPath: 'inset(0)' }}
      ref={(node) => node?.style.setProperty('pointer-events', 'none', 'important')}
    >
      <canvas
        ref={canvasRef}
        style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%' }}
      />
    </div>
  );
}

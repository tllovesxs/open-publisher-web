import { useEffect, useRef } from "react";

/** A lightweight, original ribbon field. Animation stops offscreen and in hidden tabs. */
export default function FlowBackdrop({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let width = 0;
    let height = 0;
    let frame = 0;
    let lastTime = 0;
    let phase = 0;
    let visible = false;
    const colors = [
      "154, 96, 255",
      "102, 99, 255",
      "180, 94, 219",
      "105, 142, 255",
    ];

    function draw() {
      if (!context) return;
      context.clearRect(0, 0, width, height);
      for (let ribbon = 0; ribbon < 4; ribbon += 1) {
        for (let line = 0; line < 20; line += 1) {
          context.beginPath();
          context.strokeStyle = `rgba(${colors[ribbon]}, ${0.08 + (1 - line / 20) * 0.1})`;
          context.lineWidth = line === 0 ? 1.8 : 1;
          for (let x = -20; x <= width + 20; x += 8) {
            const progress = x / width;
            const wave = Math.sin(
              progress * Math.PI * 2.1 + phase + ribbon * 0.5,
            );
            const secondary = Math.cos(
              progress * Math.PI * 3.1 - phase * 0.6 + ribbon,
            );
            const y =
              height * (0.49 + ribbon * 0.075) +
              wave * height * 0.24 +
              secondary * height * 0.08 +
              line * 3.5;
            if (x === -20) context.moveTo(x, y);
            else context.lineTo(x, y);
          }
          context.stroke();
        }
      }
    }
    function animate(time: number) {
      if (time - lastTime > 32) {
        phase += Math.min(time - lastTime, 64) * 0.00013;
        lastTime = time;
        draw();
      }
      frame = requestAnimationFrame(animate);
    }
    function sync() {
      cancelAnimationFrame(frame);
      if (active && visible && !document.hidden) {
        lastTime = performance.now();
        frame = requestAnimationFrame(animate);
      } else draw();
    }
    const resize = new ResizeObserver(() => {
      const bounds = canvas.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      const scale = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      draw();
    });
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    resize.observe(canvas);
    intersection.observe(canvas);
    document.addEventListener("visibilitychange", sync);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [active]);

  return (
    <canvas ref={canvasRef} className="gl-flow-canvas" aria-hidden="true" />
  );
}

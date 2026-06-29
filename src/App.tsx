import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Play, Pause, RotateCcw, Sliders, Eye, HelpCircle, Activity } from 'lucide-react';

interface Point3D { x: number; y: number; z: number; }
interface Point2D { x: number; y: number; d: number; }

interface Particle {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  history: { x: number; y: number }[];
}

interface Preset {
  id: string;
  name: string;
  fn: (x: number, y: number) => number;
}

export default function App() {
  // Preset definitions
  const presets: Preset[] = useMemo(() => [
    {
      id: 'ripple',
      name: 'Ripple Well (Ref)',
      fn: (x, y) => {
        const r = Math.sqrt(x * x + y * y);
        return -22 * Math.cos(r / 14) * Math.exp(-0.003 * r) - 20;
      }
    },
    {
      id: 'bowl',
      name: 'Parabolic Basin',
      fn: (x, y) => {
        const r2 = x * x + y * y;
        return (r2 / 300) - 40;
      }
    },
    {
      id: 'peaks',
      name: 'Dual Peaks & Wells',
      fn: (x, y) => {
        const d1 = (x - 35) * (x - 35) + y * y;
        const d2 = (x + 35) * (x + 35) + y * y;
        return 35 * Math.exp(-d1 / 1100) - 35 * Math.exp(-d2 / 1100) - 20;
      }
    },
    {
      id: 'saddle',
      name: 'Saddle Pass',
      fn: (x, y) => ((x * x - y * y) / 480) - 20
    },
    {
      id: 'volcano',
      name: 'Volcano Caldera',
      fn: (x, y) => {
        const r = Math.sqrt(x * x + y * y);
        return 50 * (r / 35) * Math.exp(-r / 25) - 33;
      }
    }
  ], []);

  // UI States
  const [activePresetId, setActivePresetId] = useState('ripple');
  const [sliceZ, setSliceZ] = useState(-20);
  const [floorZ, setFloorZ] = useState(-120);
  const [vectorSpacing, setVectorSpacing] = useState(14);
  const [vectorScale, setVectorScale] = useState(0.8);
  const [particleSpeed, setParticleSpeed] = useState(1.0);
  const [friction, setFriction] = useState(0.025);
  const [isClimbing, setIsClimbing] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);

  // Toggle View options
  const [showMesh, setShowMesh] = useState(true);
  const [showContours, setShowContours] = useState(true);
  const [showBaseVectors, setShowBaseVectors] = useState(true);
  const [showSlicePlane, setShowSlicePlane] = useState(true);

  // View parameters State (mirrored optionally to refs for mouse drag loop)
  const [azimuth, setAzimuth] = useState(-0.65);
  const [elevation, setElevation] = useState(0.55);
  const [zoom, setZoom] = useState(1.9);

  // Stats / HUD State
  const [hoverData, setHoverData] = useState<{ x: number; y: number; z: number; gx: number; gy: number; mag: number } | null>(null);

  // Refs for animation loop
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particlesRef = useRef<Particle[]>([]);
  const nextParticleIdRef = useRef(1);
  const mousePosRef = useRef<{ mx: number; my: number } | null>(null);

  // Animation lock refs to maintain 60 FPS under mouse interactions
  const paramsRef = useRef({
    azimuth,
    elevation,
    zoom,
    sliceZ,
    floorZ,
    showMesh,
    showContours,
    showBaseVectors,
    showSlicePlane,
    isClimbing,
    vectorSpacing,
    vectorScale,
    friction,
    particleSpeed,
    isPlaying,
    presetId: activePresetId
  });

  // Sync state to ref on change
  useEffect(() => {
    paramsRef.current = {
      azimuth,
      elevation,
      zoom,
      sliceZ,
      floorZ,
      showMesh,
      showContours,
      showBaseVectors,
      showSlicePlane,
      isClimbing,
      vectorSpacing,
      vectorScale,
      friction,
      particleSpeed,
      isPlaying,
      presetId: activePresetId
    };
  }, [azimuth, elevation, zoom, sliceZ, floorZ, showMesh, showContours, showBaseVectors, showSlicePlane, isClimbing, vectorSpacing, vectorScale, friction, particleSpeed, isPlaying, activePresetId]);

  // Current active math function
  const activePreset = useMemo(() => {
    return presets.find(p => p.id === activePresetId) || presets[0];
  }, [activePresetId, presets]);

  const fieldFn = activePreset.fn;
  const fieldFnRef = useRef(fieldFn);
  useEffect(() => {
    fieldFnRef.current = fieldFn;
  }, [fieldFn]);

  // 3D coordinate projection
  const project = (p: Point3D, w: number, h: number, az: number, el: number, zm: number): Point2D => {
    const cosA = Math.cos(az);
    const sinA = Math.sin(az);
    const x1 = p.x * cosA - p.y * sinA;
    const y1 = p.x * sinA + p.y * cosA;
    const z1 = p.z;

    const cosE = Math.cos(el);
    const sinE = Math.sin(el);
    const x2 = x1;
    const y2 = y1 * cosE - z1 * sinE;
    const z2 = y1 * sinE + z1 * cosE;

    return {
      x: w / 2 + x2 * zm,
      y: h / 2 - z2 * zm,
      d: y2 // Depth sorting coordinate
    };
  };

  // Central difference numerical gradient helper
  const getGradient = (x: number, y: number, fn: (x: number, y: number) => number) => {
    const step = 0.5;
    const x1 = Math.max(-100, Math.min(100, x + step));
    const x2 = Math.max(-100, Math.min(100, x - step));
    const y1 = Math.max(-100, Math.min(100, y + step));
    const y2 = Math.max(-100, Math.min(100, y - step));

    const gx = (fn(x1, y) - fn(x2, y)) / (x1 - x2);
    const gy = (fn(x, y1) - fn(x, y2)) / (y1 - y2);
    return { gx, gy, mag: Math.hypot(gx, gy) };
  };

  const getScalarColor = (val: number): string => {
    // Normalization bounds: [-42, 12]
    const minVal = -42;
    const maxVal = 12;
    const t = Math.max(0, Math.min(1, (val - minVal) / (maxVal - minVal)));

    // Map to an elegant, high-contrast palette
    // 0.0 -> Slate Navy Blue
    // 0.25 -> Light Teal Blue
    // 0.5 -> Desaturated Slate
    // 0.75 -> Dynamic Solar Orange
    // 1.0 -> Rich Amber Red
    if (t < 0.25) {
      const u = t / 0.25;
      return `rgb(${Math.round(15 + u * 45)}, ${Math.round(23 + u * 155)}, ${Math.round(42 + u * 200)})`;
    } else if (t < 0.5) {
      const u = (t - 0.25) / 0.25;
      return `rgb(${Math.round(60 + u * 105)}, ${Math.round(178 + u * 35)}, ${Math.round(242 - u * 65)})`;
    } else if (t < 0.75) {
      const u = (t - 0.5) / 0.25;
      return `rgb(${Math.round(165 + u * 80)}, ${Math.round(213 - u * 105)}, ${Math.round(177 - u * 140)})`;
    } else {
      const u = (t - 0.75) / 0.25;
      return `rgb(${Math.round(245 - u * 60)}, ${Math.round(108 - u * 50)}, ${Math.round(37 - u * 25)})`;
    }
  };

  // Spawners
  const rainParticles = () => {
    const list: Particle[] = [];
    for (let c = 0; c < 45; c++) {
      list.push({
        id: nextParticleIdRef.current++,
        x: (Math.random() - 0.5) * 180,
        y: (Math.random() - 0.5) * 180,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2,
        history: []
      });
    }
    particlesRef.current = [...particlesRef.current, ...list];
  };

  const clearParticles = () => {
    particlesRef.current = [];
  };

  // Drag handlers for Canvas Rotation
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    isDraggingRef.current = true;
    dragStartRef.current = { x: mx, y: my };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (isDraggingRef.current) {
      // Rotate camera angles on drag
      const dx = mx - dragStartRef.current.x;
      const dy = my - dragStartRef.current.y;

      setAzimuth(prev => prev + dx * 0.007);
      // Bound elevation to prevent flip overs
      setElevation(prev => Math.max(-1.4, Math.min(1.4, prev - dy * 0.007)));

      dragStartRef.current = { x: mx, y: my };
    } else {
      mousePosRef.current = { mx, my };
    }
  };

  const handleMouseUpOrLeave = () => {
    isDraggingRef.current = false;
  };

  // Single click drops a single particle at the targeted surface node
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isDraggingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    let bestX = 0;
    let bestY = 0;
    let minDist = Infinity;

    // Search closest 3D projected point in a fast grid
    const targetFn = fieldFnRef.current;
    const az = paramsRef.current.azimuth;
    const el = paramsRef.current.elevation;
    const zm = paramsRef.current.zoom;

    for (let gx = -100; gx <= 100; gx += 5) {
      for (let gy = -100; gy <= 100; gy += 5) {
        const gz = targetFn(gx, gy);
        const proj = project({ x: gx, y: gy, z: gz }, canvas.width, canvas.height, az, el, zm);
        const d = Math.hypot(proj.x - clickX, proj.y - clickY);
        if (d < minDist) {
          minDist = d;
          bestX = gx;
          bestY = gy;
        }
      }
    }

    if (minDist < 45) {
      particlesRef.current.push({
        id: nextParticleIdRef.current++,
        x: bestX + (Math.random() - 0.5) * 1.5,
        y: bestY + (Math.random() - 0.5) * 1.5,
        vx: 0,
        vy: 0,
        history: []
      });
    }
  };

  // Main high speed render loop
  useEffect(() => {
    let animId: number;

    const render = () => {
      const canvas = canvasRef.current;
      if (!canvas) {
        animId = requestAnimationFrame(render);
        return;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        animId = requestAnimationFrame(render);
        return;
      }

      // Handle Resize dynamically
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
      }

      const w = rect.width;
      const h = rect.height;

      // Extract current loop values from refs
      const {
        azimuth: az,
        elevation: el,
        zoom: zm,
        sliceZ: slZ,
        floorZ: flZ,
        showMesh: sMesh,
        showContours: sConts,
        showBaseVectors: sVecs,
        showSlicePlane: sSlice,
        isClimbing: climb,
        vectorSpacing: spacing,
        vectorScale: vScale,
        friction: frict,
        particleSpeed: pSpd,
        isPlaying: activePlay
      } = paramsRef.current;

      const currentFn = fieldFnRef.current;

      // Update particle physics
      if (activePlay) {
        particlesRef.current.forEach(p => {
          const { gx, gy } = getGradient(p.x, p.y, currentFn);
          const dir = climb ? 1.0 : -1.0;
          const gravityFactor = 0.55 * pSpd;

          const ax = dir * gx * gravityFactor;
          const ay = dir * gy * gravityFactor;

          p.vx = (p.vx + ax) * (1 - frict);
          p.vy = (p.vy + ay) * (1 - frict);

          p.x += p.vx;
          p.y += p.vy;

          // Trail update
          p.history.push({ x: p.x, y: p.y });
          if (p.history.length > 14) p.history.shift();

          // Bound limits
          if (p.x < -100 || p.x > 100 || p.y < -100 || p.y > 100) {
            p.x = Math.max(-100, Math.min(100, p.x));
            p.y = Math.max(-100, Math.min(100, p.y));
            p.vx *= -0.7;
            p.vy *= -0.7;
          }
        });
      }

      // Track HUD hover statistics
      if (mousePosRef.current) {
        const { mx, my } = mousePosRef.current;
        let bestPoint: { x: number; y: number; z: number } | null = null;
        let minDist = Infinity;

        // Trace on coarse spatial mesh
        for (let gx = -100; gx <= 100; gx += 4) {
          for (let gy = -100; gy <= 100; gy += 4) {
            const gz = currentFn(gx, gy);
            const proj = project({ x: gx, y: gy, z: gz }, w, h, az, el, zm);
            const d = Math.hypot(proj.x - mx, proj.y - my);
            if (d < minDist) {
              minDist = d;
              bestPoint = { x: gx, y: gy, z: gz };
            }
          }
        }

        if (minDist < 35 && bestPoint) {
          const { gx, gy, mag } = getGradient(bestPoint.x, bestPoint.y, currentFn);
          setHoverData({
            x: Math.round(bestPoint.x),
            y: Math.round(bestPoint.y),
            z: bestPoint.z,
            gx,
            gy,
            mag
          });
        } else {
          setHoverData(null);
        }
      }

      // Draw background
      ctx.fillStyle = '#0a0d14'; // space base
      ctx.fillRect(0, 0, w, h);

      // Render Floor Heatmap & Contours
      const floorRes = 35;
      const baseFloorZ = flZ;

      // Project floor grid
      const floorVerts: Point2D[][] = [];
      for (let i = 0; i <= floorRes; i++) {
        floorVerts[i] = [];
        const fx = -100 + (200 * i) / floorRes;
        for (let j = 0; j <= floorRes; j++) {
          const fy = -100 + (200 * j) / floorRes;
          floorVerts[i][j] = project({ x: fx, y: fy, z: baseFloorZ }, w, h, az, el, zm);
        }
      }

      // 1. Draw solid floor heatmap cells
      if (sConts) {
        for (let i = 0; i < floorRes; i++) {
          const x0 = -100 + (200 * i) / floorRes;
          const x1 = -100 + (200 * (i + 1)) / floorRes;
          for (let j = 0; j < floorRes; j++) {
            const y0 = -100 + (200 * j) / floorRes;
            const y1 = -100 + (200 * (j + 1)) / floorRes;

            const v0 = currentFn(x0, y0);
            const v1 = currentFn(x1, y0);
            const v2 = currentFn(x1, y1);
            const v3 = currentFn(x0, y1);
            const vAvg = (v0 + v1 + v2 + v3) / 4;

            ctx.beginPath();
            ctx.moveTo(floorVerts[i][j].x, floorVerts[i][j].y);
            ctx.lineTo(floorVerts[i + 1][j].x, floorVerts[i + 1][j].y);
            ctx.lineTo(floorVerts[i + 1][j + 1].x, floorVerts[i + 1][j + 1].y);
            ctx.lineTo(floorVerts[i][j + 1].x, floorVerts[i][j + 1].y);
            ctx.closePath();
            ctx.fillStyle = getScalarColor(vAvg);
            ctx.fill();
          }
        }

        // 2. Marching Squares contour wire loops on floor
        const contourLevels = [-40, -35, -30, -25, -20, -15, -10, -5, 0, 5, 10];
        const getCross = (pa: { x: number; y: number }, va: number, pb: { x: number; y: number }, vb: number, lvl: number) => {
          if ((va < lvl && vb >= lvl) || (vb < lvl && va >= lvl)) {
            const t = (lvl - va) / (vb - va);
            return {
              x: pa.x + t * (pb.x - pa.x),
              y: pa.y + t * (pb.y - pa.y)
            };
          }
          return null;
        };

        for (let i = 0; i < floorRes; i++) {
          const x0 = -100 + (200 * i) / floorRes;
          const x1 = -100 + (200 * (i + 1)) / floorRes;
          for (let j = 0; j < floorRes; j++) {
            const y0 = -100 + (200 * j) / floorRes;
            const y1 = -100 + (200 * (j + 1)) / floorRes;

            const p00 = { x: x0, y: y0 };
            const p10 = { x: x1, y: y0 };
            const p11 = { x: x1, y: y1 };
            const p01 = { x: x0, y: y1 };

            const v00 = currentFn(x0, y0);
            const v10 = currentFn(x1, y0);
            const v11 = currentFn(x1, y1);
            const v01 = currentFn(x0, y1);

            contourLevels.forEach(lvl => {
              const crosses: { x: number; y: number }[] = [];
              const cr0 = getCross(p00, v00, p10, v10, lvl); if (cr0) crosses.push(cr0);
              const cr1 = getCross(p10, v10, p11, v11, lvl); if (cr1) crosses.push(cr1);
              const cr2 = getCross(p11, v11, p01, v01, lvl); if (cr2) crosses.push(cr2);
              const cr3 = getCross(p01, v01, p00, v00, lvl); if (cr3) crosses.push(cr3);

              if (crosses.length >= 2) {
                const s0 = project({ x: crosses[0].x, y: crosses[0].y, z: baseFloorZ }, w, h, az, el, zm);
                const s1 = project({ x: crosses[1].x, y: crosses[1].y, z: baseFloorZ }, w, h, az, el, zm);
                ctx.beginPath();
                ctx.moveTo(s0.x, s0.y);
                ctx.lineTo(s1.x, s1.y);
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
                ctx.lineWidth = 1.1;
                ctx.stroke();
              }
            });
          }
        }
      } else {
        // Flat dark slate fallback floor
        ctx.beginPath();
        ctx.moveTo(floorVerts[0][0].x, floorVerts[0][0].y);
        ctx.lineTo(floorVerts[floorRes][0].x, floorVerts[floorRes][0].y);
        ctx.lineTo(floorVerts[floorRes][floorRes].x, floorVerts[floorRes][floorRes].y);
        ctx.lineTo(floorVerts[0][floorRes].x, floorVerts[0][floorRes].y);
        ctx.closePath();
        ctx.fillStyle = '#0f172a';
        ctx.fill();
        ctx.strokeStyle = '#1e293b';
        ctx.stroke();
      }

      // 3. Draw Floor Gradient Arrows / Vector Field
      if (sVecs) {
        for (let gx = -90; gx <= 90; gx += spacing) {
          for (let gy = -90; gy <= 90; gy += spacing) {
            const { gx: dx, gy: dy, mag } = getGradient(gx, gy, currentFn);
            if (mag < 0.05) continue;

            // Normalize and scale beautifully
            const scaleFactor = vScale * 14;
            const arrowLen = Math.max(3.5, Math.min(18, mag * scaleFactor));
            const endX = gx + (dx / mag) * arrowLen;
            const endY = gy + (dy / mag) * arrowLen;

            const startPr = project({ x: gx, y: gy, z: baseFloorZ }, w, h, az, el, zm);
            const endPr = project({ x: endX, y: endY, z: baseFloorZ }, w, h, az, el, zm);

            // Draw line
            ctx.beginPath();
            ctx.moveTo(startPr.x, startPr.y);
            ctx.lineTo(endPr.x, endPr.y);
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.72)'; // electric blue arrow
            ctx.lineWidth = 1.25;
            ctx.stroke();

            // Arrow tip
            const angle = Math.atan2(endPr.y - startPr.y, endPr.x - startPr.x);
            const headSz = 4.5;
            ctx.beginPath();
            ctx.moveTo(endPr.x, endPr.y);
            ctx.lineTo(endPr.x - headSz * Math.cos(angle - Math.PI / 6), endPr.y - headSz * Math.sin(angle - Math.PI / 6));
            ctx.lineTo(endPr.x - headSz * Math.cos(angle + Math.PI / 6), endPr.y - headSz * Math.sin(angle + Math.PI / 6));
            ctx.closePath();
            ctx.fillStyle = 'rgba(56, 189, 248, 0.9)';
            ctx.fill();
          }
        }
      }

      // Bounding Box Pillars Layout Auto sorting
      const sideNodes = [
        { x: -100, y: -100 },
        { x: 100, y: -100 },
        { x: 100, y: 100 },
        { x: -100, y: 100 }
      ];

      const rankedSides = sideNodes.map((n, idx) => {
        const prFloor = project({ x: n.x, y: n.y, z: baseFloorZ }, w, h, az, el, zm);
        return { idx, ...n, depth: prFloor.d, prFloor };
      }).sort((a, b) => b.depth - a.depth); // furthest away sorted first

      // Far pillars (behind the mesh) are rendered first
      ctx.beginPath();
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1.0;

      for (let k = 0; k < 2; k++) {
        const pillar = rankedSides[k];
        const prBottom = pillar.prFloor;
        const prTop = project({ x: pillar.x, y: pillar.y, z: 12 }, w, h, az, el, zm);

        ctx.moveTo(prBottom.x, prBottom.y);
        ctx.lineTo(prTop.x, prTop.y);
      }
      ctx.stroke();

      // Render 3D Surface grid and sort quads and particles
      const meshRes = 25; // elegant spacing grid
      const quadsList: any[] = [];

      for (let i = 0; i < meshRes; i++) {
        const mx0 = -100 + (200 * i) / meshRes;
        const mx1 = -100 + (200 * (i + 1)) / meshRes;
        for (let j = 0; j < meshRes; j++) {
          const my0 = -100 + (200 * j) / meshRes;
          const my1 = -100 + (200 * (j + 1)) / meshRes;

          const mz0 = currentFn(mx0, my0);
          const mz1 = currentFn(mx1, my0);
          const mz2 = currentFn(mx1, my1);
          const mz3 = currentFn(mx0, my1);
          const zAvg = (mz0 + mz1 + mz2 + mz3) / 4;

          const p0 = project({ x: mx0, y: my0, z: mz0 }, w, h, az, el, zm);
          const p1 = project({ x: mx1, y: my0, z: mz1 }, w, h, az, el, zm);
          const p2 = project({ x: mx1, y: my1, z: mz2 }, w, h, az, el, zm);
          const p3 = project({ x: mx0, y: my1, z: mz3 }, w, h, az, el, zm);

          const depth = (p0.d + p1.d + p2.d + p3.d) / 4;

          // Shading computation
          // Define model vectors AB and AD to compute surface normal
          const ab = { x: mx1 - mx0, y: 0, z: mz1 - mz0 };
          const ad = { x: 0, y: my1 - my0, z: mz3 - mz0 };
          // Cross product
          const nx = ab.y * ad.z - ab.z * ad.y;
          const ny = ab.z * ad.x - ab.x * ad.z;
          const nz = ab.x * ad.y - ab.y * ad.x;
          const nLen = Math.hypot(nx, ny, nz);
          const normal = nLen > 0 ? { x: nx / nLen, y: ny / nLen, z: nz / nLen } : { x: 0, y: 0, z: 1 };

          // Light source direction vector from upper-right-front
          const lightDir = { x: 0.35, y: -0.4, z: 0.84 };
          const lLen = Math.hypot(lightDir.x, lightDir.y, lightDir.z);
          const lightNorm = { x: lightDir.x / lLen, y: lightDir.y / lLen, z: lightDir.z / lLen };

          // Diffuse component
          const dot = normal.x * lightNorm.x + normal.y * lightNorm.y + normal.z * lightNorm.z;
          const diff = Math.max(0, dot);

          // Render scale colors to orange / rust
          const shadeR = Math.max(30, Math.min(252, 60 + diff * 192));
          const shadeG = Math.max(15, Math.min(180, 20 + diff * 125));
          const shadeB = Math.max(5, Math.min(60, 5 + diff * 45));

          quadsList.push({
            type: 'quad',
            depth,
            pts: [p0, p1, p2, p3],
            pts3d: [
              { x: mx0, y: my0, z: mz0 },
              { x: mx1, y: my0, z: mz1 },
              { x: mx1, y: my1, z: mz2 },
              { x: mx0, y: my1, z: mz3 }
            ],
            fillCol: `rgba(${Math.round(shadeR)}, ${Math.round(shadeG)}, ${Math.round(shadeB)}, 0.91)`,
            zAvg
          });
        }
      }

      // Collect active particles for sorting
      const renderParticles = particlesRef.current.map(p => {
        const pz = currentFn(p.x, p.y);
        const centerPr = project({ x: p.x, y: p.y, z: pz }, w, h, az, el, zm);

        // Project trace nodes
        const trailPr: Point2D[] = [];
        p.history.forEach(pt => {
          const trailZ = currentFn(pt.x, pt.y);
          trailPr.push(project({ x: pt.x, y: pt.y, z: trailZ }, w, h, az, el, zm));
        });

        return {
          type: 'particle',
          depth: centerPr.d,
          screenPos: centerPr,
          trailPr,
          id: p.id
        };
      });

      // Assembly rendering items
      let compositeList: any[] = [...quadsList, ...renderParticles];

      // Add Slice plane sheet to the visual stack
      if (sSlice) {
        const slicePr = project({ x: 0, y: 0, z: slZ }, w, h, az, el, zm);
        compositeList.push({
          type: 'slice-plane',
          depth: slicePr.d,
          zHeight: slZ
        });
      }

      // Depth sorting (furthest elements back, closest elements forward)
      compositeList.sort((a, b) => b.depth - a.depth);

      // Render the sorted visual items
      compositeList.forEach(item => {
        if (item.type === 'quad') {
          // Mesh cells
          ctx.beginPath();
          ctx.moveTo(item.pts[0].x, item.pts[0].y);
          ctx.lineTo(item.pts[1].x, item.pts[1].y);
          ctx.lineTo(item.pts[2].x, item.pts[2].y);
          ctx.lineTo(item.pts[3].x, item.pts[3].y);
          ctx.closePath();
          ctx.fillStyle = item.fillCol;
          ctx.fill();

          if (sMesh) {
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }

          // Compute exact 3D custom highlights where the horizontal cut slice crosses this quad
          if (sSlice) {
            const cutZ = slZ;
            const crossings: Point2D[] = [];

            const checkEdgeCut = (pA: Point3D, pB: Point3D) => {
              if ((pA.z < cutZ && pB.z >= cutZ) || (pB.z < cutZ && pA.z >= cutZ)) {
                const ratio = (cutZ - pA.z) / (pB.z - pA.z);
                const interPt = {
                  x: pA.x + ratio * (pB.x - pA.x),
                  y: pA.y + ratio * (pB.y - pA.y),
                  z: cutZ
                };
                crossings.push(project(interPt, w, h, az, el, zm));
              }
            };

            checkEdgeCut(item.pts3d[0], item.pts3d[1]);
            checkEdgeCut(item.pts3d[1], item.pts3d[2]);
            checkEdgeCut(item.pts3d[2], item.pts3d[3]);
            checkEdgeCut(item.pts3d[3], item.pts3d[0]);

            if (crossings.length >= 2) {
              ctx.beginPath();
              ctx.moveTo(crossings[0].x, crossings[0].y);
              ctx.lineTo(crossings[1].x, crossings[1].y);
              ctx.strokeStyle = '#ff3b30'; // burning red neon cutline
              ctx.lineWidth = 2.5;
              ctx.stroke();

              // Highlight outline core
              ctx.strokeStyle = '#ffffff';
              ctx.lineWidth = 1.0;
              ctx.stroke();
            }
          }
        } else if (item.type === 'particle') {
          // Trails
          if (item.trailPr.length > 1) {
            ctx.beginPath();
            ctx.moveTo(item.trailPr[0].x, item.trailPr[0].y);
            for (let i = 1; i < item.trailPr.length; i++) {
              ctx.lineTo(item.trailPr[i].x, item.trailPr[i].y);
            }
            ctx.strokeStyle = climb ? 'rgba(52, 211, 153, 0.44)' : 'rgba(239, 68, 68, 0.44)';
            ctx.lineWidth = 2.2;
            ctx.stroke();
          }

          // Marble core sphere
          ctx.beginPath();
          ctx.arc(item.screenPos.x, item.screenPos.y, 4.8, 0, 2 * Math.PI);
          ctx.fillStyle = climb ? '#10b981' : '#ef4444'; // emerald green or crimson red
          ctx.fill();

          ctx.beginPath();
          ctx.arc(item.screenPos.x - 1.4, item.screenPos.y - 1.4, 1.2, 0, 2 * Math.PI);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
        } else if (item.type === 'slice-plane') {
          // Render translucent amber glass cutting sheet
          const s0 = project({ x: -100, y: -100, z: slZ }, w, h, az, el, zm);
          const s1 = project({ x: 100, y: -100, z: slZ }, w, h, az, el, zm);
          const s2 = project({ x: 100, y: 100, z: slZ }, w, h, az, el, zm);
          const s3 = project({ x: -100, y: 100, z: slZ }, w, h, az, el, zm);

          ctx.beginPath();
          ctx.moveTo(s0.x, s0.y);
          ctx.lineTo(s1.x, s1.y);
          ctx.lineTo(s2.x, s2.y);
          ctx.lineTo(s3.x, s3.y);
          ctx.closePath();
          ctx.fillStyle = 'rgba(239, 68, 68, 0.08)'; // cool transparent red slice pane
          ctx.fill();
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.35)'; // solid boundary
          ctx.lineWidth = 1.0;
          ctx.stroke();
        }
      });

      // Front pillars of Bounding Box drawn in front of the mesh
      ctx.beginPath();
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1.25;

      for (let k = 2; k < 4; k++) {
        const pillar = rankedSides[k];
        const prBottom = pillar.prFloor;
        const prTop = project({ x: pillar.x, y: pillar.y, z: 12 }, w, h, az, el, zm);

        ctx.moveTo(prBottom.x, prBottom.y);
        ctx.lineTo(prTop.x, prTop.y);
      }
      ctx.stroke();

      // Top and Bottom enclosing wire borders
      ctx.beginPath();
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1.2;

      const baseRing = sideNodes.map(n => project({ x: n.x, y: n.y, z: baseFloorZ }, w, h, az, el, zm));
      const topRing = sideNodes.map(n => project({ x: n.x, y: n.y, z: 12 }, w, h, az, el, zm));

      ctx.moveTo(baseRing[0].x, baseRing[0].y);
      for (let s = 1; s < 4; s++) ctx.lineTo(baseRing[s].x, baseRing[s].y);
      ctx.closePath();

      ctx.moveTo(topRing[0].x, topRing[0].y);
      for (let s = 1; s < 4; s++) ctx.lineTo(topRing[s].x, topRing[s].y);
      ctx.closePath();
      ctx.stroke();

      // Draw Axis ticks & labels
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px Space Grotesk, system-ui, sans-serif';
      ctx.textAlign = 'center';

      // 1. Z-axis tick scales labeled -4.0 to +1.0
      const leftPillarIdx = rankedSides[3].idx; // Dynamic leftmost projected screen corner
      const leftCorner = sideNodes[leftPillarIdx];
      const zScaleTicks = [-40, -30, -20, -10, 0, 10];

      zScaleTicks.forEach(tickZ => {
        const prTick = project({ x: leftCorner.x, y: leftCorner.y, z: tickZ }, w, h, az, el, zm);
        // Draw small horizontal dash
        ctx.beginPath();
        ctx.moveTo(prTick.x, prTick.y);
        ctx.lineTo(prTick.x - 5, prTick.y);
        ctx.strokeStyle = '#64748b';
        ctx.stroke();

        // Convert -40 model value to physical -4.0 representation
        const labelVal = (tickZ / 10).toFixed(1);
        ctx.textAlign = 'right';
        ctx.fillText(labelVal, prTick.x - 8, prTick.y + 3);
      });

      // 2. X and Y axes labeling along custom bottom borders
      ctx.textAlign = 'center';
      const ticksXY = [-80, -40, 0, 40, 80];

      // Draw along corner 0 -> corner 1 (X)
      const c0 = sideNodes[0];
      const c1 = sideNodes[1];
      ticksXY.forEach(val => {
        const pt = { x: val, y: c0.y, z: baseFloorZ };
        const pr = project(pt, w, h, az, el, zm);
        ctx.fillText(val.toString(), pr.x, pr.y + 14);
      });

      // Draw along corner 1 -> corner 2 (Y)
      const c2 = sideNodes[2];
      ticksXY.forEach(val => {
        const pt = { x: c1.x, y: val, z: baseFloorZ };
        const pr = project(pt, w, h, az, el, zm);
        ctx.fillText(val.toString(), pr.x, pr.y + 14);
      });

      // Simple Axes Labels
      const xLabelPr = project({ x: 0, y: -110, z: baseFloorZ }, w, h, az, el, zm);
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.fillText('X AXIS', xLabelPr.x, xLabelPr.y + 26);

      const yLabelPr = project({ x: 110, y: 0, z: baseFloorZ }, w, h, az, el, zm);
      ctx.fillText('Y AXIS', yLabelPr.x, yLabelPr.y + 26);

      const zLabelPr = project({ x: leftCorner.x, y: leftCorner.y, z: 20 }, w, h, az, el, zm);
      ctx.fillText('f(x, y)', zLabelPr.x, zLabelPr.y - 8);

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [presets]);

  return (
    <div id="simulator_container" className="flex w-screen h-screen bg-[#080a10] text-[#eaeef6] overflow-hidden font-sans select-none">
      {/* LEFT CONTROL PANEL (23% Width) */}
      <div id="sidebar_controls" className="w-[23%] h-full bg-[#0d111d] border-r border-[#1e293b] flex flex-col justify-between p-5 overflow-y-auto">
        <div className="space-y-6">
          {/* Header Title */}
          <div>
            <div className="flex items-center space-x-2 text-[#38bdf8]">
              <Activity className="w-5 h-5 text-[#38bdf8]" />
              <span className="text-xs font-bold uppercase tracking-widest">Physics Core</span>
            </div>
            <h1 className="text-xl font-black tracking-wide text-white mt-1 uppercase">Gradient Flow</h1>
            <p className="text-[11px] text-[#64748b] mt-1 leading-relaxed">
              High-performance scalar field &amp; steepest ascent vectors.
            </p>
          </div>

          <hr className="border-[#1e293b]" />

          {/* Preset Functions */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-[#94a3b8] uppercase tracking-wider block">Scalar Field Function</label>
            <div className="space-y-1.5" id="presets_selector">
              {presets.map(p => (
                <button
                  key={p.id}
                  id={`preset_${p.id}`}
                  onClick={() => setActivePresetId(p.id)}
                  className={`w-full text-left px-3 py-2 rounded-md text-xs font-medium transition-all ${
                    activePresetId === p.id
                      ? 'bg-gradient-to-r from-[#f97316] to-[#ea580c] text-white shadow-lg shadow-orange-500/15'
                      : 'bg-[#151c2c] hover:bg-[#1f293d] text-[#cbd5e1]'
                  }`}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          <hr className="border-[#1e293b]" />

          {/* Interactive Parameters */}
          <div className="space-y-4">
            <div className="flex items-center space-x-2">
              <Sliders className="w-4 h-4 text-[#94a3b8]" />
              <span className="text-xs font-bold text-[#94a3b8] uppercase tracking-wider">Adjustment Parameters</span>
            </div>

            {/* Slice height slider */}
            <div className="space-y-1.5" id="slice_control_container">
              <div className="flex justify-between text-[11px]">
                <span className="text-[#94a3b8]">Slice Plane Height (Z)</span>
                <span className="text-white font-mono">{(sliceZ / 10).toFixed(1)}</span>
              </div>
              <input
                id="slice_z_slider"
                type="range"
                min="-40"
                max="10"
                step="1"
                value={sliceZ}
                onChange={e => setSliceZ(parseInt(e.target.value))}
                className="w-full h-1 bg-[#1a2333] rounded-lg appearance-none cursor-pointer accent-[#ea580c]"
              />
            </div>

            {/* Vector arrow density slider */}
            <div className="space-y-1.5" id="vector_spacing_container">
              <div className="flex justify-between text-[11px]">
                <span className="text-[#94a3b8]">Vector Grid Spacing</span>
                <span className="text-white font-mono">{vectorSpacing}</span>
              </div>
              <input
                id="vector_spacing_slider"
                type="range"
                min="10"
                max="20"
                step="1"
                value={vectorSpacing}
                onChange={e => setVectorSpacing(parseInt(e.target.value))}
                className="w-full h-1 bg-[#1a2333] rounded-lg appearance-none cursor-pointer accent-[#ea580c]"
              />
            </div>

            {/* Vector arrow size slider */}
            <div className="space-y-1.5" id="vector_scale_container">
              <div className="flex justify-between text-[11px]">
                <span className="text-[#94a3b8]">Gradient Arrow Scale</span>
                <span className="text-white font-mono">{vectorScale.toFixed(1)}x</span>
              </div>
              <input
                id="vector_scale_slider"
                type="range"
                min="0.3"
                max="1.5"
                step="0.1"
                value={vectorScale}
                onChange={e => setVectorScale(parseFloat(e.target.value))}
                className="w-full h-1 bg-[#1a2333] rounded-lg appearance-none cursor-pointer accent-[#ea580c]"
              />
            </div>

            {/* Particle speed slider */}
            <div className="space-y-1.5" id="particle_speed_container">
              <div className="flex justify-between text-[11px]">
                <span className="text-[#94a3b8]">Simulation Physics Speed</span>
                <span className="text-white font-mono">{particleSpeed.toFixed(1)}x</span>
              </div>
              <input
                id="particle_speed_slider"
                type="range"
                min="0.2"
                max="2.5"
                step="0.1"
                value={particleSpeed}
                onChange={e => setParticleSpeed(parseFloat(e.target.value))}
                className="w-full h-1 bg-[#1a2333] rounded-lg appearance-none cursor-pointer accent-[#ea580c]"
              />
            </div>

            {/* Zoom Level slider */}
            <div className="space-y-1.5" id="zoom_level_container">
              <div className="flex justify-between text-[11px]">
                <span className="text-[#94a3b8]">Zoom Level</span>
                <span className="text-white font-mono">{zoom.toFixed(1)}x</span>
              </div>
              <input
                id="zoom_slider"
                type="range"
                min="0.8"
                max="3.5"
                step="0.1"
                value={zoom}
                onChange={e => setZoom(parseFloat(e.target.value))}
                className="w-full h-1 bg-[#1a2333] rounded-lg appearance-none cursor-pointer accent-[#ea580c]"
              />
            </div>

            {/* Floor Separation height slider */}
            <div className="space-y-1.5" id="floor_z_container">
              <div className="flex justify-between text-[11px]">
                <span className="text-[#94a3b8]">Projection Floor Offset (Z)</span>
                <span className="text-white font-mono">{(floorZ / 10).toFixed(1)}</span>
              </div>
              <input
                id="floor_z_slider"
                type="range"
                min="-200"
                max="-45"
                step="5"
                value={floorZ}
                onChange={e => setFloorZ(parseInt(e.target.value))}
                className="w-full h-1 bg-[#1a2333] rounded-lg appearance-none cursor-pointer accent-[#ea580c]"
              />
            </div>
          </div>

          <hr className="border-[#1e293b]" />

          {/* Visual Overlay Toggles */}
          <div className="space-y-3">
            <div className="flex items-center space-x-2">
              <Eye className="w-4 h-4 text-[#94a3b8]" />
              <span className="text-xs font-bold text-[#94a3b8] uppercase tracking-wider">Visual Overlays</span>
            </div>

            <div className="grid grid-cols-2 gap-2" id="visual_toggles">
              <button
                id="toggle_mesh"
                onClick={() => setShowMesh(!showMesh)}
                className={`py-1.5 px-2 rounded text-[10px] font-bold transition-all ${
                  showMesh ? 'bg-[#ea580c]/20 text-orange-400 border border-[#ea580c]/55' : 'bg-[#151c2c] text-[#64748b] border border-transparent'
                }`}
              >
                Mesh Grid
              </button>
              <button
                id="toggle_contours"
                onClick={() => setShowContours(!showContours)}
                className={`py-1.5 px-2 rounded text-[10px] font-bold transition-all ${
                  showContours ? 'bg-[#ea580c]/20 text-orange-400 border border-[#ea580c]/55' : 'bg-[#151c2c] text-[#64748b] border border-transparent'
                }`}
              >
                Base Map
              </button>
              <button
                id="toggle_vectors"
                onClick={() => setShowBaseVectors(!showBaseVectors)}
                className={`py-1.5 px-2 rounded text-[10px] font-bold transition-all ${
                  showBaseVectors ? 'bg-[#ea580c]/20 text-orange-400 border border-[#ea580c]/55' : 'bg-[#151c2c] text-[#64748b] border border-transparent'
                }`}
              >
                Gradient Arrows
              </button>
              <button
                id="toggle_slice"
                onClick={() => setShowSlicePlane(!showSlicePlane)}
                className={`py-1.5 px-2 rounded text-[10px] font-bold transition-all ${
                  showSlicePlane ? 'bg-[#ea580c]/20 text-orange-400 border border-[#ea580c]/55' : 'bg-[#151c2c] text-[#64748b] border border-transparent'
                }`}
              >
                Slice Plane
              </button>
            </div>
          </div>
        </div>

        {/* Marbles Dynamics Box */}
        <div className="mt-6 space-y-3 pt-4 border-t border-[#1e293b]" id="particles_dynamics_section">
          <label className="text-xs font-semibold text-[#94a3b8] uppercase tracking-wider block">Particle Control</label>
          
          <div className="flex gap-2">
            <button
              id="toggle_play"
              onClick={() => setIsPlaying(!isPlaying)}
              className="flex-1 py-1.5 rounded text-[11px] font-bold flex items-center justify-center space-x-1 transition-all bg-[#22c55e]/25 text-green-400 hover:bg-[#22c55e]/35"
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              <span>{isPlaying ? 'Pause' : 'Resume'}</span>
            </button>

            <button
              id="btn_clear_particles"
              onClick={clearParticles}
              className="px-2.5 py-1.5 rounded bg-[#ef4444]/15 hover:bg-[#ef4444]/25 text-red-400 transition-all text-xs"
              title="Clear all marbles"
            >
              Clear
            </button>
          </div>

          <button
            id="btn_rain_particles"
            onClick={rainParticles}
            className="w-full py-2 rounded text-xs font-black transition-all bg-gradient-to-r from-blue-600 to-[#38bdf8] text-white hover:opacity-95 shadow-md shadow-blue-500/10"
          >
            Scatter Marbles (x45)
          </button>

          {/* Climb Gradient Ascent vs Descent toggle */}
          <div className="flex items-center justify-between p-2 rounded-lg bg-[#151c2c] text-[11px] mt-1" id="gradient_direction_toggle">
            <span className="text-[#94a3b8]">Gradient Path</span>
            <button
              id="btn_climb_toggle"
              onClick={() => setIsClimbing(!isClimbing)}
              className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase transition-all ${
                isClimbing ? 'bg-[#10b981] text-white' : 'bg-red-600 text-white'
              }`}
            >
              {isClimbing ? 'Climb (Ascent)' : 'Fall (Descent)'}
            </button>
          </div>
        </div>
      </div>

      {/* RIGHT WORKSPACE AND CANVAS (77% Width) */}
      <div id="simulation_workspace" className="w-[77%] h-full relative flex flex-col items-center justify-center bg-[#07090e]">
        
        {/* Glow red UDVASH Element top-right corner */}
        <div id="udvash_glow_corner" className="absolute top-5 right-6 z-15 select-none pointer-events-none">
          <div className="text-right">
            <div className="font-extrabold text-2xl text-red-500 tracking-widest uppercase drop-shadow-[0_0_12px_rgba(239,68,68,0.95)] animate-pulse">
              UDVASH
            </div>
            <div className="text-[9px] text-red-400/60 uppercase tracking-widest font-mono text-right mt-0.5">
              Numerical Physics Labs
            </div>
          </div>
        </div>

        {/* Hover Coordinate HUD Tooltip (Bottom-Left) */}
        <div id="coordinate_hud" className="absolute bottom-5 left-6 z-15 bg-slate-950/85 backdrop-blur-md p-3.5 rounded-lg border border-[#334155] font-mono text-[11px] space-y-1 text-slate-300 min-w-[210px] shadow-2xl">
          <div className="text-[#38bdf8] font-bold text-xs border-b border-slate-800 pb-1 flex items-center justify-between">
            <span>COORDINATE METRICS</span>
            <span className="text-[9px] bg-sky-500/20 px-1 py-0.2 rounded text-sky-400">LIVE</span>
          </div>
          {hoverData ? (
            <div className="space-y-1 mt-1.5">
              <div className="flex justify-between">
                <span>Position (X, Y):</span>
                <span className="text-white font-bold">{hoverData.x}, {hoverData.y}</span>
              </div>
              <div className="flex justify-between border-b border-slate-900/40 pb-0.5">
                <span>Height f(x,y):</span>
                <span className="text-orange-400 font-bold">{(hoverData.z / 10).toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>Gradient ∇f_x:</span>
                <span className="text-white">{(hoverData.gx / 10).toFixed(3)}</span>
              </div>
              <div className="flex justify-between">
                <span>Gradient ∇f_y:</span>
                <span className="text-white">{(hoverData.gy / 10).toFixed(3)}</span>
              </div>
              <div className="flex justify-between font-bold text-[#10b981] border-t border-slate-900 mt-1 pt-0.5">
                <span>Slope Mag |∇f|:</span>
                <span>{(hoverData.mag / 10).toFixed(3)}</span>
              </div>
            </div>
          ) : (
            <div className="text-slate-500 italic mt-1.5 py-1 text-center">
              Hover cursor over surface...
            </div>
          )}
        </div>

        {/* Manual Drag Indicator HUD */}
        <div className="absolute top-5 left-6 z-15 flex items-center space-x-2 text-xs text-[#64748b] bg-slate-950/40 px-3 py-1.5 rounded-md border border-[#1e293b]/50">
          <HelpCircle className="w-3.5 h-3.5 text-[#38bdf8]" />
          <span>Drag to Rotate • Click to Drop Marbles</span>
        </div>

        {/* The 3D High-Speed Canvas */}
        <canvas
          ref={canvasRef}
          id="physics_renderer"
          className="w-full h-full cursor-grab active:cursor-grabbing outline-none"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUpOrLeave}
          onMouseLeave={handleMouseUpOrLeave}
          onClick={handleCanvasClick}
        />
      </div>
    </div>
  );
}

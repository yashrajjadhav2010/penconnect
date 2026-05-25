/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useEffect, useState } from 'react';
import { Stroke, Point } from '../types';

interface DrawingCanvasProps {
  strokes: Stroke[];
  activeIncomingStrokes?: Record<string, Stroke>;
  mode: 'tablet' | 'laptop';
  currentTool: 'pen' | 'highlighter' | 'eraser';
  currentColor: string;
  currentWidth: number;
  palmRejection: boolean;
  gridType: 'none' | 'dot' | 'graph' | 'ruled';
  isDarkMode: boolean;
  onStrokeAdd?: (stroke: Stroke) => void;
  onStrokePointsAdd?: (strokeId: string, points: Point[]) => void;
  onStrokeEnd?: (stroke: Stroke) => void;
  onStrokeErase?: (erasedIds: string[]) => void;
  pan: { x: number; y: number };
  setPan: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  zoom: number;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  autoFollowActive?: boolean;
}

export default function DrawingCanvas({
  strokes,
  activeIncomingStrokes = {},
  mode,
  currentTool,
  currentColor,
  currentWidth,
  palmRejection,
  gridType,
  isDarkMode,
  onStrokeAdd,
  onStrokePointsAdd,
  onStrokeEnd,
  onStrokeErase,
  pan,
  setPan,
  zoom,
  setZoom,
  autoFollowActive = false,
}: DrawingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDrawingRef = useRef(false);
  const activeStrokeIdRef = useRef<string | null>(null);
  const activePointsRef = useRef<Point[]>([]);
  const strokeStartTimeRef = useRef<number>(0);
  
  // Track continuous touches/pointers for desktop scrolling & viewport pan/zoom
  const [isPanning, setIsPanning] = useState(false);
  const pointersRef = useRef<Record<string, { x: number; y: number }>>({});
  const initialTouchDistanceRef = useRef<number | null>(null);
  const initialZoomRef = useRef<number>(1);
  const initialPanRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Store dimensions locally for viewport calculations
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  // Handle ResizeObserver resize dynamically
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries || entries.length === 0) return;
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
    });

    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  // Update canvas sizing based on devicePixelRatio to prevent blurry lines
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = dimensions.width * dpr;
    canvas.height = dimensions.height * dpr;
    
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(dpr, dpr);
    }
    
    draw();
  }, [dimensions, strokes, activeIncomingStrokes, pan, zoom, gridType, isDarkMode]);

  // Handle follow-writer logic: when there are incoming drawings, automatically adjust Laptop viewport
  useEffect(() => {
    if (mode === 'laptop' && autoFollowActive) {
      const activeIds = Object.keys(activeIncomingStrokes);
      if (activeIds.length > 0) {
        const activeStroke = activeIncomingStrokes[activeIds[0]];
        if (activeStroke && activeStroke.points.length > 0) {
          const latestPoint = activeStroke.points[activeStroke.points.length - 1];
          
          // Smooth follow writer: shift pan so the writer point is centered in our viewport
          // Target position: screen center is (dimensions.width/2, dimensions.height/2)
          // screenX = worldX * zoom + panX => panX = screenX - worldX * zoom
          const targetPanX = dimensions.width / 2 - latestPoint.x * zoom;
          const targetPanY = dimensions.height / 2 - latestPoint.y * zoom;
          
          setPan((prev) => ({
            x: prev.x + (targetPanX - prev.x) * 0.1,
            y: prev.y + (targetPanY - prev.y) * 0.1,
          }));
        }
      }
    }
  }, [activeIncomingStrokes, mode, autoFollowActive, zoom, dimensions]);

  // Main drawing routine
  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 1. Clear background
    ctx.clearRect(0, 0, dimensions.width, dimensions.height);
    ctx.fillStyle = isDarkMode ? '#121214' : '#F9FAFB';
    ctx.fillRect(0, 0, dimensions.width, dimensions.height);

    // 2. Draw study paper grid guidelines matching current pan & zoom
    drawGrid(ctx);

    // 3. Render strokes in translated world space
    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);

    // Render historical completed strokes
    strokes.forEach((stroke) => {
      drawStrokePath(ctx, stroke);
    });

    // Render local active drawing stroke
    if (isDrawingRef.current && activePointsRef.current.length > 0) {
      const activeStroke: Stroke = {
        id: activeStrokeIdRef.current || 'temp',
        points: activePointsRef.current,
        color: currentColor,
        width: currentWidth,
        tool: currentTool,
      };
      drawStrokePath(ctx, activeStroke);
    }

    // Render incoming synchronizing active strokes
    Object.values(activeIncomingStrokes).forEach((stroke) => {
      drawStrokePath(ctx, stroke);
    });

    ctx.restore();
  };

  // Grid drawing function
  const drawGrid = (ctx: CanvasRenderingContext2D) => {
    if (gridType === 'none') return;
    
    const strokeColor = isDarkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.04)';
    const dotColor = isDarkMode ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.10)';
    
    const size = 32 * zoom; // dynamic scaling cell sizes
    if (size < 8) return;   // don't paint tiny crowded patterns to avoid canvas slow-downs
    
    const startX = pan.x % size;
    const startY = pan.y % size;

    ctx.save();
    
    if (gridType === 'graph' || gridType === 'ruled') {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 1;
      
      // Vertical graph paper guides
      if (gridType === 'graph') {
        for (let x = startX; x < dimensions.width; x += size) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, dimensions.height);
          ctx.stroke();
        }
      }
      
      // Horizontal ruled guides
      for (let y = startY; y < dimensions.height; y += size) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(dimensions.width, y);
        ctx.stroke();
      }
    } else if (gridType === 'dot') {
      ctx.fillStyle = dotColor;
      const dotRadius = Math.max(0.6, 1.2 * Math.min(1.5, zoom));
      for (let x = startX; x < dimensions.width + 10; x += size) {
        for (let y = startY; y < dimensions.height + 10; y += size) {
          ctx.beginPath();
          ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    
    ctx.restore();
  };

  // Helper to draw a single complete stroke using Bezier midpoint interpolation
  const drawStrokePath = (ctx: CanvasRenderingContext2D, stroke: Stroke) => {
    const pts = stroke.points;
    if (pts.length === 0) return;

    ctx.save();
    
    // Set rendering style based on tool choice
    if (stroke.tool === 'highlighter') {
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = stroke.color;
      ctx.globalCompositeOperation = isDarkMode ? 'screen' : 'multiply';
      ctx.lineCap = 'square';
      ctx.lineJoin = 'miter';
    } else {
      ctx.globalAlpha = 1.0;
      ctx.strokeStyle = stroke.color;
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }

    ctx.lineWidth = stroke.width;

    // Check if we have pressure-sensitive points to draw tapered paths
    const hasPressure = pts.some(p => p.p !== undefined && p.p > 0);
    
    if (hasPressure && stroke.tool === 'pen') {
      // For stylistic calligraphy rendering, draw segment by segment with changing width
      ctx.lineCap = 'round';
      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];
        
        // Compute pressure-interpolated line width
        const p1Pressure = p1.p ?? 0.5;
        const p2Pressure = p2.p ?? 0.5;
        const segmentWidth = stroke.width * (0.4 + 0.9 * ((p1Pressure + p2Pressure) / 2));
        
        ctx.beginPath();
        ctx.lineWidth = segmentWidth;
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
    } else {
      // High-performance Standard smooth bezier curved line
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);

      if (pts.length === 1) {
        ctx.lineTo(pts[0].x + 0.1, pts[0].y + 0.1);
        ctx.stroke();
      } else if (pts.length === 2) {
        ctx.lineTo(pts[1].x, pts[1].y);
        ctx.stroke();
      } else {
        for (let i = 1; i < pts.length - 1; i++) {
          const xc = (pts[i].x + pts[i + 1].x) / 2;
          const yc = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
        }
        ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
        ctx.stroke();
      }
    }

    ctx.restore();
  };

  // Translate screen pointer coords to virtual world coords
  const screenToWorld = (screenX: number, screenY: number) => {
    return {
      x: (screenX - pan.x) / zoom,
      y: (screenY - pan.y) / zoom,
    };
  };

  // Pointer event handlers
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Prevent scrolling / bouncing in mobile browsers
    if (e.cancelable) e.preventDefault();
    canvas.setPointerCapture(e.pointerId);

    // Track active pointer positions (for multi-touch pinching)
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    pointersRef.current[e.pointerId] = { x, y };

    const pointerCount = Object.keys(pointersRef.current).length;

    // Palm Rejection checking:
    // If enabled, strictly refuse 'touch' input for drawing, unless 2 pointers are panning.
    if (palmRejection && e.pointerType === 'touch' && currentTool !== 'eraser') {
      if (pointerCount < 2) {
        // Suppress drawing
        return;
      }
    }

    // MULTI-TOUCH GESTURE (Pinching or 2 finger navigation)
    if (pointerCount >= 2) {
      isDrawingRef.current = false;
      setIsPanning(true);
      
      const pointerIds = Object.keys(pointersRef.current);
      const p1 = pointersRef.current[pointerIds[0]];
      const p2 = pointersRef.current[pointerIds[1]];
      
      // Calculate start zoom parameters
      initialTouchDistanceRef.current = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      initialZoomRef.current = zoom;
      initialPanRef.current = { ...pan };
      return;
    }

    // If stylus or touch mouse is left-clicking in navigation mode
    if (e.buttons !== 1 && e.pointerType !== 'pen') return;

    const worldCoord = screenToWorld(x, y);

    // ERASER INTERSECTION MODE (Stroke eraser)
    if (currentTool === 'eraser') {
      isDrawingRef.current = true;
      eraseAtPoint(worldCoord.x, worldCoord.y);
      return;
    }

    // INITIALIZE A STROKE
    isDrawingRef.current = true;
    const strokeId = `s_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    activeStrokeIdRef.current = strokeId;
    strokeStartTimeRef.current = Date.now();

    const pressure = e.pointerType === 'pen' ? e.pressure : undefined;
    const startPoint: Point = {
      x: worldCoord.x,
      y: worldCoord.y,
      p: pressure !== undefined && pressure > 0 ? pressure : undefined,
      t: 0,
    };

    activePointsRef.current = [startPoint];

    if (onStrokeAdd) {
      onStrokeAdd({
        id: strokeId,
        points: activePointsRef.current,
        color: currentColor,
        width: currentWidth,
        tool: currentTool,
      });
    }

    // Canvas redrawn immediately
    draw();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Save moving coordinates
    if (pointersRef.current[e.pointerId]) {
      pointersRef.current[e.pointerId] = { x, y };
    }

    const pointerCount = Object.keys(pointersRef.current).length;

    // PINCH ZOOM / TWO-FINGER PANNING
    if (pointerCount >= 2 && isPanning) {
      const pointerIds = Object.keys(pointersRef.current);
      const p1 = pointersRef.current[pointerIds[0]];
      const p2 = pointersRef.current[pointerIds[1]];

      // 1. Calculate Panning (movement of the midpoint)
      const currentMidX = (p1.x + p2.x) / 2;
      const currentMidY = (p1.y + p2.y) / 2;

      // 2. Calculate Zoom (scaling factor)
      const currentDistance = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const initialDistance = initialTouchDistanceRef.current || currentDistance;
      const zoomRatio = currentDistance / initialDistance;
      
      const newZoom = Math.max(0.15, Math.min(6, initialZoomRef.current * zoomRatio));
      
      // Update viewport pan/zoom state with pinch focal point centering
      setZoom(newZoom);
      
      // Track original midpoint in screen
      const originalMidX = (pointersRef.current[pointerIds[0]].x + pointersRef.current[pointerIds[1]].x) / 2;
      // Simple offset panning movement
      // Just map raw scrolling panning relative to start
      // To keep it smooth, standard panning is sufficient:
      setPan((prev) => {
        // Panning tracking relative shift
        return {
          x: currentMidX - (currentMidX - initialPanRef.current.x) * (newZoom / initialZoomRef.current),
          y: currentMidY - (currentMidY - initialPanRef.current.y) * (newZoom / initialZoomRef.current),
        };
      });

      draw();
      return;
    }

    // Single pointer active
    if (!isDrawingRef.current) return;

    const worldCoord = screenToWorld(x, y);

    // Eraser brush tracking
    if (currentTool === 'eraser') {
      eraseAtPoint(worldCoord.x, worldCoord.y);
      return;
    }

    // Normal drawing pen tracking
    if (!activeStrokeIdRef.current) return;

    const pressure = e.pointerType === 'pen' ? e.pressure : undefined;
    const newPoint: Point = {
      x: worldCoord.x,
      y: worldCoord.y,
      p: pressure !== undefined && pressure > 0 ? pressure : undefined,
      t: Date.now() - strokeStartTimeRef.current,
    };

    activePointsRef.current.push(newPoint);

    // Stream point chunk to data-channel immediately in real time
    if (onStrokePointsAdd) {
      onStrokePointsAdd(activeStrokeIdRef.current, [newPoint]);
    }

    draw();
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.releasePointerCapture(e.pointerId);
    }

    // Clean pointer registers
    delete pointersRef.current[e.pointerId];
    const pointerCount = Object.keys(pointersRef.current).length;

    if (pointerCount === 0) {
      setIsPanning(false);
      initialTouchDistanceRef.current = null;
    }

    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;

    if (currentTool === 'eraser') {
      activeStrokeIdRef.current = null;
      activePointsRef.current = [];
      return;
    }

    if (activeStrokeIdRef.current) {
      if (onStrokeEnd) {
        onStrokeEnd({
          id: activeStrokeIdRef.current,
          points: [...activePointsRef.current],
          color: currentColor,
          width: currentWidth,
          tool: currentTool,
        });
      }
    }

    activeStrokeIdRef.current = null;
    activePointsRef.current = [];
    draw();
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    delete pointersRef.current[e.pointerId];
    if (Object.keys(pointersRef.current).length === 0) {
      setIsPanning(false);
    }
  };

  // Erase stroke intersection checker
  const eraseAtPoint = (worldX: number, worldY: number) => {
    if (!onStrokeErase) return;
    const erasedIds: string[] = [];
    // Dynamic brush radius that adapts to target zoom (so physical screen size erased is consistent)
    const worldThreshold = 18 / zoom; 

    strokes.forEach((stroke) => {
      let hit = false;
      for (const p of stroke.points) {
        const dx = p.x - worldX;
        const dy = p.y - worldY;
        if (dx * dx + dy * dy < worldThreshold * worldThreshold) {
          hit = true;
          break;
        }
      }
      if (hit) {
        erasedIds.push(stroke.id);
      }
    });

    if (erasedIds.length > 0 && onStrokeErase) {
      onStrokeErase(erasedIds);
    }
  };

  // Mouse wheel scroll to pan & zoom (for laptops with trackpads)
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const isZooming = e.ctrlKey || Math.abs(e.deltaY) < 15; // standard pinch-to-zoom signatures

    if (isZooming) {
      // Zoom centered on pointer
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const worldBefore = screenToWorld(mouseX, mouseY);
      
      const zoomFactor = 1.05;
      const newZoom = e.deltaY < 0 
        ? Math.min(6, zoom * zoomFactor) 
        : Math.max(0.15, zoom / zoomFactor);
      
      setZoom(newZoom);
      
      // Recalculate pan so pointer world position is unchanged
      setPan({
        x: mouseX - worldBefore.x * newZoom,
        y: mouseY - worldBefore.y * newZoom,
      });
    } else {
      // Standard scrolling acts as pan
      // Multiplier can make trackpad feel ultra responsive
      setPan((prev) => ({
        x: prev.x - e.deltaX * 0.8,
        y: prev.y - e.deltaY * 0.8,
      }));
    }
    draw();
  };

  return (
    <div 
      id="canvas-container"
      ref={containerRef}
      className="relative w-full h-full bg-stone-100 overflow-hidden outline-none select-none"
    >
      <canvas
        id="handwriting-canvas"
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onWheel={handleWheel}
        className="block touch-none cursor-crosshair w-full h-full"
      />
      
      {/* Dynamic zoom calibration overlay */}
      <div className="absolute bottom-6 right-6 px-3 py-1 bg-black/60 backdrop-blur-md text-white rounded-md text-xs font-mono select-none pointer-events-none transition-opacity duration-300">
        Zoom: {Math.round(zoom * 100)}%
      </div>
    </div>
  );
}

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Pen, 
  Highlighter, 
  Eraser, 
  Undo2, 
  Redo2, 
  Trash2, 
  Grid, 
  Download, 
  Monitor, 
  Tablet, 
  Wifi, 
  WifiOff, 
  Maximize2, 
  Minimize2, 
  ZoomIn, 
  ZoomOut, 
  Move,
  Info,
  Layers,
  Settings,
  HelpCircle,
  Eye,
  EyeOff,
  Moon,
  Sun,
  ShieldCheck,
  RefreshCw,
  Compass
} from 'lucide-react';
import { Stroke, Point, ConnectionState, DeviceMode, PeerMessage } from './types';
import DrawingCanvas from './components/DrawingCanvas';
import WebRTCPairing from './components/WebRTCPairing';

const PEN_COLORS = [
  { name: 'Charcoal', hex: '#1C1917' },
  { name: 'Navy', hex: '#1E3A8A' },
  { name: 'Forest', hex: '#065F46' },
  { name: 'Crimson', hex: '#991B1B' },
  { name: 'Purple', hex: '#6D28D9' },
  { name: 'Orange', hex: '#C2410C' },
];

const HIGHLIGHTER_COLORS = [
  { name: 'Neon Yellow', hex: '#FACC15' },
  { name: 'Aqua Blue', hex: '#38BDF8' },
  { name: 'Soft Pink', hex: '#F472B6' },
  { name: 'Mint Green', hex: '#4ADE80' },
];

const BRUSH_WIDTHS = [
  { name: 'Fine', value: 2.5 },
  { name: 'Medium', value: 4.5 },
  { name: 'Thick', value: 7 },
];

const GRID_TYPES = [
  { id: 'none', label: 'Plain' },
  { id: 'dot', label: 'Dot Grid' },
  { id: 'graph', label: 'Graph' },
  { id: 'ruled', label: 'Ruled' },
];

export default function App() {
  // Device mode & P2P connection refs
  const [deviceMode, setDeviceMode] = useState<DeviceMode>('unselected');
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const [activePin, setActivePin] = useState<string>('');

  // States
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [undoStack, setUndoStack] = useState<Stroke[][]>([]);
  const [redoStack, setRedoStack] = useState<Stroke[][]>([]);
  const [activeIncomingStrokes, setActiveIncomingStrokes] = useState<Record<string, Stroke>>({});

  // Active stylus parameters
  const [currentTool, setCurrentTool] = useState<'pen' | 'highlighter' | 'eraser'>('pen');
  const [currentColor, setCurrentColor] = useState<string>('#1C1917');
  const [currentWidth, setCurrentWidth] = useState<number>(2.5);
  const [palmRejection, setPalmRejection] = useState<boolean>(false);
  const [gridType, setGridType] = useState<'none' | 'dot' | 'graph' | 'ruled'>('dot');
  const [isDarkMode, setIsDarkMode] = useState<boolean>(false);

  // Layout parameters
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState<number>(1);
  const [autoFollow, setAutoFollow] = useState<boolean>(true);
  const [showGuideModal, setShowGuideModal] = useState<boolean>(false);

  // Connection latency checking (pings)
  const [connectionLatency, setConnectionLatency] = useState<number | null>(null);
  const pingIntervalRef = useRef<number | null>(null);

  // Refs to prevent state closure staleness in EventSource/polling listeners
  const strokesRef = useRef(strokes);
  const undoStackRef = useRef(undoStack);
  const redoStackRef = useRef(redoStack);

  useEffect(() => {
    strokesRef.current = strokes;
    undoStackRef.current = undoStack;
    redoStackRef.current = redoStack;
  }, [strokes, undoStack, redoStack]);

  // Clean resources on unmount
  useEffect(() => {
    return () => {
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      if (dataChannelRef.current) dataChannelRef.current.close();
      if (peerConnectionRef.current) peerConnectionRef.current.close();
    };
  }, []);

  // Set default color when swapping tools
  useEffect(() => {
    if (currentTool === 'highlighter') {
      setCurrentColor(HIGHLIGHTER_COLORS[0].hex);
      setCurrentWidth(16);
    } else if (currentTool === 'pen') {
      setCurrentColor(PEN_COLORS[0].hex);
      setCurrentWidth(2.5);
    } else if (currentTool === 'eraser') {
      setCurrentWidth(12);
    }
  }, [currentTool]);

  // Common message broadcasting pipeline via BOTH WebRTC or reliable Server HTTPSync
  const broadcastMessage = async (msg: PeerMessage) => {
    // 1. WebRTC direct low-latency send (if open)
    const dc = dataChannelRef.current;
    if (dc && dc.readyState === 'open') {
      try {
        dc.send(JSON.stringify(msg));
      } catch (err) {
        console.warn('[WebRTC] sync channel write error:', err);
      }
    }

    // 2. HTTP Server Sync fallback (100% reliable, works across iframes, NATs, and networks)
    if (activePin) {
      try {
        await fetch('api/sync/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pin: activePin,
            sender: deviceMode,
            message: msg
          })
        });
      } catch (err) {
        console.error('[HTTP Sync] Post message failed:', err);
      }
    }
  };

  // Sync state emitter helper
  const sendSyncState = () => {
    broadcastMessage({
      type: 'sync-state',
      strokes: strokesRef.current,
      undoStack: undoStackRef.current,
      redoStack: redoStackRef.current,
    });
  };

  // Unpack and process standard sync drawing events
  const handleIncomingMessage = (msg: PeerMessage) => {
    switch (msg.type) {
      case 'sync-request':
        // Tablet receives this from Laptop. Emit full state.
        if (deviceMode === 'tablet') {
          broadcastMessage({
            type: 'sync-state',
            strokes: strokesRef.current,
            undoStack: undoStackRef.current,
            redoStack: redoStackRef.current,
          });
        }
        break;

      case 'sync-state':
        // Laptop viewer receives full strokes dump
        if (deviceMode === 'laptop') {
          setStrokes(msg.strokes);
          setUndoStack(msg.undoStack);
          setRedoStack(msg.redoStack);
        }
        break;

      case 'draw-start':
        if (deviceMode === 'laptop') {
          setActiveIncomingStrokes((prev) => ({
            ...prev,
            [msg.stroke.id]: msg.stroke,
          }));
        }
        break;

      case 'draw-points':
        if (deviceMode === 'laptop') {
          setActiveIncomingStrokes((prev) => {
            const target = prev[msg.id];
            if (!target) return prev;
            return {
              ...prev,
              [msg.id]: {
                ...target,
                points: [...target.points, ...msg.points],
              },
            };
          });
        }
        break;

      case 'draw-end':
        if (deviceMode === 'laptop') {
          setActiveIncomingStrokes((prev) => {
            const finishedStroke = prev[msg.id];
            if (finishedStroke) {
              setStrokes((current) => [...current, finishedStroke]);
            }
            const copy = { ...prev };
            delete copy[msg.id];
            return copy;
          });
        }
        break;

      case 'undo':
        if (deviceMode === 'laptop') {
          handleUndoLocal();
        }
        break;

      case 'redo':
        if (deviceMode === 'laptop') {
          handleRedoLocal();
        }
        break;

      case 'clear':
        if (deviceMode === 'laptop') {
          handleClearLocal();
        }
        break;

      case 'ping':
        // Echo back pong instantly if we can
        const dc = dataChannelRef.current;
        if (dc && dc.readyState === 'open') {
          dc.send(JSON.stringify({ type: 'pong', time: msg.time }));
        }
        break;

      case 'pong':
        const rtt = Date.now() - msg.time;
        setConnectionLatency(rtt);
        break;
    }
  };

  // Setup data channel listeners after connection establishes
  const handleDataChannelReady = (dc: RTCDataChannel) => {
    dc.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as PeerMessage;
        handleIncomingMessage(msg);
      } catch (err) {
        console.error('Failed to handle incoming WebRTC message:', err);
      }
    };

    // Begin low-weight roundtrip ping interval for telemetry
    if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
    pingIntervalRef.current = window.setInterval(() => {
      if (dc.readyState === 'open') {
        dc.send(JSON.stringify({ type: 'ping', time: Date.now() }));
      } else {
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }
      }
    }, 4500);

    // If we are Laptop, request sync
    if (deviceMode === 'laptop') {
      broadcastMessage({ type: 'sync-request' });
    }
  };

  // Real-time synchronization stream (SSE + Polling Fallback)
  useEffect(() => {
    if (!activePin || deviceMode === 'unselected') return;

    let eventSource: EventSource | null = null;
    let pollInterval: any = null;
    let active = true;
    let lastCheckedMessageId = 0;

    const startEventStream = () => {
      try {
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }

        const streamUrl = `api/sync/stream?pin=${activePin}&client=${deviceMode}`;
        eventSource = new EventSource(streamUrl);

        eventSource.onopen = () => {
          console.log('[SSE] Stream established with PIN:', activePin);
        };

        eventSource.onmessage = (event) => {
          if (!active) return;
          try {
            const raw = JSON.parse(event.data);
            if (raw && raw.type) {
              handleIncomingMessage(raw);
            }
          } catch (err) {
            // keep-alive or empty payload
          }
        };

        eventSource.onerror = (err) => {
          console.warn('[SSE] Stream error, falling back to fast polling in 2 seconds:', err);
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
          if (active) {
            setTimeout(() => {
              if (active) startPolling();
            }, 2000);
          }
        };
      } catch (err) {
        console.error('[SSE] Failed to construct EventSource, falling back to polling:', err);
        startPolling();
      }
    };

    const startPolling = () => {
      if (pollInterval) return;
      console.log('[Poll] Starting fallback HTTP sync polling...');

      pollInterval = setInterval(async () => {
        if (!active) return;
        try {
          const res = await fetch(`api/sync/poll-data?pin=${activePin}&lastId=${lastCheckedMessageId}&client=${deviceMode}`);
          if (!res.ok) return;
          const data = await res.json();
          if (data.messages && data.messages.length > 0) {
            data.messages.forEach((msg: PeerMessage) => {
              handleIncomingMessage(msg);
            });
          }
          if (data.lastId) {
            lastCheckedMessageId = data.lastId;
          }
        } catch (err) {
          console.error('[Poll] Sync error:', err);
        }
      }, 1000);
    };

    startEventStream();

    // Laptop requests immediate drawing pad notes
    if (deviceMode === 'laptop') {
      broadcastMessage({ type: 'sync-request' });
    }

    return () => {
      active = false;
      if (eventSource) {
        eventSource.close();
      }
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [activePin, deviceMode]);

  // -------------------------------------------------------------
  // LOCAL DRAWING EVENT FLOWS (On Tablet Device)
  // -------------------------------------------------------------
  const handleStrokeAdd = (newStroke: Stroke) => {
    // 1. Push current states to undo registry first
    setRedoStack([]);
    setUndoStack((prev) => [...prev, strokes]);

    // 2. Broadcast write event
    broadcastMessage({ type: 'draw-start', stroke: newStroke });
  };

  const handleStrokePointsAdd = (strokeId: string, newPoints: Point[]) => {
    broadcastMessage({ type: 'draw-points', id: strokeId, points: newPoints });
  };

  const handleStrokeEnd = (completedStroke: Stroke) => {
    // Append completed points to local list
    setStrokes((current) => [...current, completedStroke]);

    // Notify Peer that drawing of this stroke completed
    broadcastMessage({ type: 'draw-end', id: completedStroke.id });
  };

  // Erasing strokes handler
  const handleStrokeErase = (erasedIds: string[]) => {
    if (erasedIds.length === 0) return;
    setUndoStack((prev) => [...prev, strokes]);
    setRedoStack([]);

    const updated = strokes.filter((s) => !erasedIds.includes(s.id));
    setStrokes(updated);

    // Sync updated drawing deck directly to viewer
    broadcastMessage({
      type: 'sync-state',
      strokes: updated,
      undoStack: undoStackRef.current,
      redoStack: redoStackRef.current,
    });
  };

  // -------------------------------------------------------------
  // CONTROL ACTION ROUTINES (Undo, Redo, Clear, High-Res Export)
  // -------------------------------------------------------------
  const handleUndoLocal = () => {
    if (undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev, strokes]);
    setStrokes(previous);
  };

  const handleUndoEmit = () => {
    if (undoStack.length === 0) return;
    handleUndoLocal();
    broadcastMessage({ type: 'undo' });
  };

  const handleRedoLocal = () => {
    if (redoStack.length === 0) return;
    const nextStrokes = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));
    setUndoStack((prev) => [...prev, strokes]);
    setStrokes(nextStrokes);
  };

  const handleRedoEmit = () => {
    if (redoStack.length === 0) return;
    handleRedoLocal();
    broadcastMessage({ type: 'redo' });
  };

  const handleClearLocal = () => {
    setUndoStack((prev) => [...prev, strokes]);
    setRedoStack([]);
    setStrokes([]);
    setActiveIncomingStrokes({});
  };

  const handleClearEmit = () => {
    handleClearLocal();
    broadcastMessage({ type: 'clear' });
  };

  // Multi-viewport calibration: auto-fit zoom and center to encompass all drawings
  const fitDrawingsToViewport = () => {
    if (strokes.length === 0) {
      setPan({ x: 0, y: 0 });
      setZoom(1);
      return;
    }

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    strokes.forEach((stroke) => {
      stroke.points.forEach((p) => {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      });
    });

    const drawWidth = maxX - minX;
    const drawHeight = maxY - minY;

    if (drawWidth <= 0 || drawHeight <= 0) return;

    const canvasContainer = document.getElementById('canvas-container');
    if (!canvasContainer) return;
    
    const viewportWidth = canvasContainer.clientWidth;
    const viewportHeight = canvasContainer.clientHeight;

    // Ideal zoom factor with padding multipliers
    const scaleX = (viewportWidth - 120) / drawWidth;
    const scaleY = (viewportHeight - 120) / drawHeight;
    const targetZoom = Math.max(0.25, Math.min(3.0, Math.min(scaleX, scaleY)));

    setZoom(targetZoom);
    // Center target bounding box
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    setPan({
      x: viewportWidth / 2 - midX * targetZoom,
      y: viewportHeight / 2 - midY * targetZoom,
    });
  };

  // High quality PNG vector renderer + download trigger
  const exportAsPNG = () => {
    if (strokes.length === 0) return;

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    strokes.forEach((stroke) => {
      stroke.points.forEach((p) => {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      });
    });

    if (minX === Infinity) return;

    // Padding framing
    const padding = 60;
    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;

    const width = maxX - minX;
    const height = maxY - minY;

    const offscreen = document.createElement('canvas');
    const scaleDPR = 2; // high res crisp export
    offscreen.width = width * scaleDPR;
    offscreen.height = height * scaleDPR;

    const ctx = offscreen.getContext('2d');
    if (!ctx) return;

    ctx.scale(scaleDPR, scaleDPR);
    ctx.fillStyle = isDarkMode ? '#121214' : '#FFFFFF';
    ctx.fillRect(0, 0, width, height);

    ctx.translate(-minX, -minY);

    // Draw grid template on export if requested
    if (gridType !== 'none') {
      const gridSize = 32;
      const strokeColor = isDarkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)';
      const dotColor = isDarkMode ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.07)';
      
      const startX = Math.floor(minX / gridSize) * gridSize;
      const startY = Math.floor(minY / gridSize) * gridSize;

      if (gridType === 'graph' || gridType === 'ruled') {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 1;

        if (gridType === 'graph') {
          for (let x = startX; x < maxX; x += gridSize) {
            ctx.beginPath();
            ctx.moveTo(x, minY);
            ctx.lineTo(x, maxY);
            ctx.stroke();
          }
        }

        for (let y = startY; y < maxY; y += gridSize) {
          ctx.beginPath();
          ctx.moveTo(minX, y);
          ctx.lineTo(maxX, y);
          ctx.stroke();
        }
      } else if (gridType === 'dot') {
        ctx.fillStyle = dotColor;
        for (let x = startX; x < maxX; x += gridSize) {
          for (let y = startY; y < maxY; y += gridSize) {
            ctx.beginPath();
            ctx.arc(x, y, 1.2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    // Render strokes
    strokes.forEach((stroke) => {
      ctx.save();
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

      const pts = stroke.points;
      if (pts.length > 0) {
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
    });

    const link = document.createElement('a');
    link.download = `JEE_Physics_Notes_${Date.now()}.png`;
    link.href = offscreen.toDataURL('image/png');
    link.click();
  };

  const handleDisconnect = () => {
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    setConnectionLatency(null);
    setConnectionState('idle');
    setDeviceMode('unselected');
    setActivePin('');
    setStrokes([]);
    setUndoStack([]);
    setRedoStack([]);
    setActiveIncomingStrokes({});
  };

  // If connection is not yet established, show the Pairing view wizard
  if (connectionState !== 'connected') {
    return (
      <WebRTCPairing
        deviceMode={deviceMode}
        setDeviceMode={setDeviceMode}
        connectionState={connectionState}
        setConnectionState={setConnectionState}
        peerConnectionRef={peerConnectionRef}
        dataChannelRef={dataChannelRef}
        onDataChannelReady={handleDataChannelReady}
        activePin={activePin}
        setActivePin={setActivePin}
      />
    );
  }

  // -------------------------------------------------------------
  // ACTIVE WORKSPACE DESIGNS
  // -------------------------------------------------------------
  return (
    <div className={`flex flex-col w-screen h-screen overflow-hidden ${isDarkMode ? 'dark bg-stone-950 text-stone-100' : 'bg-stone-50 text-stone-850'} select-none`}>
      
      {/* GLOBAL HUD NAVBAR */}
      <header className={`flex items-center justify-between px-4 py-3 border-b shrink-0 ${isDarkMode ? 'bg-stone-900 border-stone-800' : 'bg-white border-stone-200'} shadow-sm`}>
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center p-1.5 bg-indigo-150 dark:bg-stone-800 rounded-lg text-indigo-600 dark:text-indigo-400">
            {deviceMode === 'tablet' ? <Tablet className="w-5 h-5" /> : <Monitor className="w-5 h-5" />}
            <span className="absolute -top-1.5 -right-1.5 flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
            </span>
          </div>
          <div>
            <span className="font-sans font-semibold text-sm leading-none flex items-center gap-2">
              Desk Workspace
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-medium ${deviceMode === 'tablet' ? 'bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-400 border border-teal-100 dark:border-teal-900/30' : 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-900/30'}`}>
                {deviceMode === 'tablet' ? 'Tablet Pen' : 'Laptop Screen'}
              </span>
            </span>
            <div className="flex items-center gap-2 text-[10px] text-stone-400 mt-0.5">
              <span className="flex items-center gap-1">
                <Wifi className="w-3 h-3 text-emerald-500" /> Connected (Direct Local link)
              </span>
              {connectionLatency !== null && (
                <span>• latency: <strong className="font-mono text-emerald-500">{connectionLatency}ms</strong></span>
              )}
            </div>
          </div>
        </div>

        {/* Global Toolbar Utilities */}
        <div className="flex items-center gap-2">
          {/* Guide toggle button */}
          <button 
            onClick={() => setShowGuideModal(true)}
            className={`p-2 rounded-lg transition-colors cursor-pointer ${isDarkMode ? 'hover:bg-stone-800 text-stone-300' : 'hover:bg-stone-150 text-stone-600'}`}
            title="Show Offline Guide"
          >
            <HelpCircle className="w-4 h-4" />
          </button>

          {/* Grid Guideline Paper Selector (rendered on both sides) */}
          <div className="flex items-center border rounded-lg overflow-hidden shrink-0 h-9 bg-stone-100 dark:bg-stone-800 border-stone-200 dark:border-stone-700 px-1 gap-1">
            <span className="text-[10px] uppercase font-semibold text-stone-400 tracking-wider px-2 select-none shrink-0">Grid:</span>
            {GRID_TYPES.map((grid) => (
              <button
                key={grid.id}
                onClick={() => setGridType(grid.id as any)}
                className={`text-[10px] px-2.5 py-1 rounded-md font-medium transition-all cursor-pointer ${
                  gridType === grid.id 
                    ? 'bg-white dark:bg-stone-700 shadow-sm text-stone-850 dark:text-stone-50 font-semibold' 
                    : 'text-stone-400 dark:text-stone-500 hover:text-stone-700 hover:bg-stone-200 dark:hover:bg-stone-850'
                }`}
              >
                {grid.label}
              </button>
            ))}
          </div>

          {/* Laptop Mode specific toggles */}
          {deviceMode === 'laptop' && (
            <>
              {/* Auto Follow Writer */}
              <button 
                onClick={() => setAutoFollow(prev => !prev)}
                className={`h-9 px-3 border rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer select-none ${
                  autoFollow 
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/20 dark:text-emerald-400 dark:border-emerald-900/30' 
                    : 'bg-stone-100 text-stone-400 border-stone-200 dark:bg-stone-800'
                }`}
                title="Automatically scroll workspace center to the writer's pen point"
              >
                {autoFollow ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4 text-stone-400" />}
                Auto-Follow
              </button>

              {/* Theme toggle */}
              <button 
                onClick={() => setIsDarkMode(prev => !prev)}
                className={`p-2 rounded-lg border cursor-pointer h-9 w-9 flex items-center justify-center transition-colors ${isDarkMode ? 'bg-stone-800 text-amber-400 border-stone-700 hover:bg-stone-750' : 'bg-stone-50 text-stone-600 border-stone-200 hover:bg-stone-100'}`}
                title="Toggle Dark Slate Blackboard style"
              >
                {isDarkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>

              <button 
                onClick={fitDrawingsToViewport}
                className={`p-2 rounded-lg border cursor-pointer h-9 w-9 flex items-center justify-center transition-colors ${isDarkMode ? 'bg-stone-800 text-stone-300 border-stone-700 hover:bg-stone-750' : 'bg-stone-50 text-stone-600 border-stone-200 hover:bg-stone-100'}`}
                title="Fit All Drawings on Screen"
              >
                <Maximize2 className="w-4 h-4" />
              </button>
            </>
          )}

          {/* Export Button */}
          <button 
            onClick={exportAsPNG}
            disabled={strokes.length === 0}
            className="h-9 px-3.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-stone-200 disabled:text-stone-450 dark:disabled:bg-stone-800 dark:disabled:text-stone-600 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 shadow-sm transition-all cursor-pointer shrink-0"
            title="Download crisp PNG Notebook Page offline"
          >
            <Download className="w-3.5 h-3.5" />
            Export Page
          </button>

          {/* Close connection safety */}
          <button 
            onClick={handleDisconnect}
            className="h-9 px-3 border border-red-200 dark:border-red-900/30 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 hover:bg-red-100 text-xs font-semibold rounded-lg cursor-pointer transition-colors shrink-0"
          >
            Disconnect Link
          </button>
        </div>
      </header>

      {/* CORE WORKSPACE SPLIT CONTAINER */}
      <div className="flex-1 min-h-0 relative flex">
        
        {/* VIEWPORT CONTROLS HUD (Floating action panel) */}
        <div className="absolute top-4 left-4 z-20 flex flex-col gap-2 pointer-events-none">
          {/* Zoom Level Indicator Controls */}
          <div className="bg-white/95 dark:bg-stone-900/95 backdrop-blur-md border border-stone-200 dark:border-stone-800 p-1.5 rounded-xl shadow-lg flex flex-col gap-1 pointer-events-auto">
            <button 
              onClick={() => setZoom(prev => Math.min(6, prev * 1.15))}
              className="p-2 hover:bg-stone-100 dark:hover:bg-stone-850 rounded-lg text-stone-700 dark:text-stone-300 cursor-pointer"
              title="Zoom In (or Use Pinch Touch / Scrollwheel)"
            >
              <ZoomIn className="w-4.5 h-4.5" />
            </button>
            
            <span className="text-[10px] font-mono font-bold text-center text-stone-500 py-1 border-y border-stone-100 dark:border-stone-800 select-none">
              {Math.round(zoom * 100)}%
            </span>

            <button 
              onClick={() => setZoom(prev => Math.max(0.15, prev / 1.15))}
              className="p-2 hover:bg-stone-100 dark:hover:bg-stone-850 rounded-lg text-stone-700 dark:text-stone-300 cursor-pointer"
              title="Zoom Out"
            >
              <ZoomOut className="w-4.5 h-4.5" />
            </button>
            
            <button 
              onClick={() => { setPan({ x: 0, y: 0 }); setZoom(1); }}
              className="p-2 hover:bg-stone-100 dark:hover:bg-stone-850 rounded-lg text-stone-400 dark:text-stone-500 cursor-pointer mt-1"
              title="Re-center Infinite Frame Canvas"
            >
              <Move className="w-4 h-4 animate-pulse" />
            </button>
          </div>
        </div>

        {/* --- TABLET PEN STYLUS BAR HUD --- */}
        {deviceMode === 'tablet' && (
          <div className="absolute top-4 right-4 z-20 flex flex-col gap-3 pointer-events-none items-end">
            
            {/* Primary Drawing Tool deck */}
            <div className="bg-white/95 dark:bg-stone-900/95 backdrop-blur-md border border-stone-200 dark:border-stone-800 p-2 rounded-2xl shadow-xl flex items-center gap-1.5 pointer-events-auto">
              
              <button 
                onClick={() => setCurrentTool('pen')}
                className={`flex items-center gap-1 px-3 py-2 rounded-xl transition-all font-semibold text-xs cursor-pointer ${
                  currentTool === 'pen'
                    ? 'bg-indigo-600 text-white shadow-md'
                    : 'text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-805'
                }`}
              >
                <Pen className="w-4 h-4" />
                Pen
              </button>

              <button 
                onClick={() => setCurrentTool('highlighter')}
                className={`flex items-center gap-1 px-3 py-2 rounded-xl transition-all font-semibold text-xs cursor-pointer ${
                  currentTool === 'highlighter'
                    ? 'bg-teal-600 text-white shadow-md'
                    : 'text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-805'
                }`}
              >
                <Highlighter className="w-4 h-4" />
                Highlight
              </button>

              <button 
                onClick={() => setCurrentTool('eraser')}
                className={`flex items-center gap-1 px-3 py-2 rounded-xl transition-all font-semibold text-xs cursor-pointer ${
                  currentTool === 'eraser'
                    ? 'bg-amber-600 text-white shadow-md'
                    : 'text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-805'
                }`}
              >
                <Eraser className="w-4 h-4" />
                Eraser
              </button>

              <div className="w-px h-6 bg-stone-200 dark:bg-stone-800 mx-1" />

              {/* Undo/Redo/Bin bar */}
              <button 
                onClick={handleUndoEmit}
                disabled={undoStack.length === 0}
                className="p-2 text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-850 disabled:text-stone-300 dark:disabled:text-stone-800 rounded-lg cursor-pointer transition-colors"
                title="Undo (Ctrl+Z)"
              >
                <Undo2 className="w-4 h-4" />
              </button>

              <button 
                onClick={handleRedoEmit}
                disabled={redoStack.length === 0}
                className="p-2 text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-850 disabled:text-stone-300 dark:disabled:text-stone-800 rounded-lg cursor-pointer transition-colors"
                title="Redo (Ctrl+Y)"
              >
                <Redo2 className="w-4 h-4" />
              </button>

              <button 
                onClick={handleClearEmit}
                disabled={strokes.length === 0}
                className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/25 rounded-lg cursor-pointer transition-colors"
                title="Clear Notebook Sheet"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            {/* Stylus Thickness & Color Picker Details panel */}
            {currentTool !== 'eraser' && (
              <div className="bg-white/95 dark:bg-stone-900/95 backdrop-blur-md border border-stone-200 dark:border-stone-800 p-3 rounded-2xl shadow-xl flex flex-col gap-3 pointer-events-auto w-64">
                {/* Selectors for Pen Size widths */}
                <div>
                  <h5 className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-2">Pen Thickness</h5>
                  <div className="grid grid-cols-3 gap-1 px-0.5">
                    {(currentTool === 'highlighter' ? [{ name: 'Thick', value: 16 }, { name: 'Thicker', value: 24 }, { name: 'Broad', value: 36 }] : BRUSH_WIDTHS).map((brush) => (
                      <button
                        key={brush.value}
                        onClick={() => setCurrentWidth(brush.value)}
                        className={`text-2xs py-1.5 rounded-lg border font-medium cursor-pointer transition-all ${
                          currentWidth === brush.value
                            ? 'bg-stone-950 text-white dark:bg-stone-100 dark:text-stone-950 font-semibold'
                            : 'border-stone-100 hover:bg-stone-50 dark:border-stone-850 dark:text-stone-300 dark:hover:bg-stone-800'
                        }`}
                      >
                        <div className="flex flex-col items-center gap-1">
                          <span 
                            className="bg-stone-805 dark:bg-stone-350 rounded-full block" 
                            style={{ width: `${Math.min(10, brush.value * 0.7 + 1)}px`, height: `${Math.min(10, brush.value * 0.7 + 1)}px` }} 
                          />
                          {brush.name}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Color swatches */}
                <div>
                  <h5 className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-2">Ink Swatch</h5>
                  <div className="grid grid-cols-5 gap-1.5">
                    {(currentTool === 'highlighter' ? HIGHLIGHTER_COLORS : PEN_COLORS).map((color) => {
                      const isSelected = currentColor.toLowerCase() === color.hex.toLowerCase();
                      return (
                        <button
                          key={color.hex}
                          onClick={() => setCurrentColor(color.hex)}
                          className={`aspect-square w-8 h-8 rounded-full shadow-inner border relative group transition-transform hover:scale-110 active:scale-95 cursor-pointer ${
                            isSelected 
                              ? 'ring-2 ring-indigo-505 dark:ring-indigo-400 border-white' 
                              : 'border-stone-200 dark:border-stone-800'
                          }`}
                          style={{ backgroundColor: color.hex }}
                          title={color.name}
                        >
                          {isSelected && (
                            <span className="absolute inset-0 flex items-center justify-center">
                              <span className="w-1.5 h-1.5 rounded-full bg-white shadow-sm invert dark:invert-0" />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* PALM REJECTION TACTICAL CONFIG */}
                <div className="border-t border-stone-100 dark:border-stone-800 pt-2 flex items-center justify-between">
                  <div>
                    <span className="text-[11px] font-semibold text-stone-700 dark:text-stone-300 flex items-center gap-1.5">
                      <ShieldCheck className={`w-4 h-4 ${palmRejection ? 'text-emerald-500' : 'text-stone-400'}`} />
                      Palm Rejection
                    </span>
                    <p className="text-[9px] text-stone-400 shrink-0 leading-none mt-0.5">Ignore touchscreen touch if using stylus</p>
                  </div>
                  <div className="relative inline-flex items-center cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={palmRejection}
                      onChange={(e) => setPalmRejection(e.target.checked)}
                      className="sr-only peer" 
                    />
                    <div className="w-9 h-5 bg-stone-200 peer-focus:outline-none rounded-full peer dark:bg-stone-805 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-teal-605"></div>
                  </div>
                </div>

              </div>
            )}
          </div>
        )}

        {/* THE MAIN WHITEBOARD CANVAS WINDOW */}
        <div className="flex-1 w-full h-full relative">
          <DrawingCanvas
            strokes={strokes}
            activeIncomingStrokes={activeIncomingStrokes}
            mode={deviceMode}
            currentTool={currentTool}
            currentColor={currentColor}
            currentWidth={currentWidth}
            palmRejection={palmRejection}
            gridType={gridType}
            isDarkMode={isDarkMode}
            onStrokeAdd={handleStrokeAdd}
            onStrokePointsAdd={handleStrokePointsAdd}
            onStrokeEnd={handleStrokeEnd}
            onStrokeErase={handleStrokeErase}
            pan={pan}
            setPan={setPan}
            zoom={zoom}
            setZoom={setZoom}
            autoFollowActive={autoFollow}
          />
        </div>

      </div>

      {/* --- JEE OFFLINE GUIDE INSTRUCTIONS MODAL CARD --- */}
      {showGuideModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm select-none">
          <div className={`p-6 rounded-2xl max-w-lg w-full shadow-2xl border ${isDarkMode ? 'bg-stone-900 border-stone-800 text-stone-100' : 'bg-white border-stone-200 text-stone-800'} animate-in fade-in zoom-in-95 duration-200`}>
            
            <div className="flex items-center justify-between pb-4 border-b border-stone-100 dark:border-stone-800">
              <h3 className="font-sans font-semibold text-lg flex items-center gap-2">
                <Compass className="w-5 h-5 text-indigo-500" />
                JEE Desk Setup Guide
              </h3>
              <button 
                onClick={() => setShowGuideModal(false)}
                className="p-1 hover:bg-stone-100 dark:hover:bg-stone-800 rounded-full transition-colors text-stone-400 hover:text-stone-200 text-xs font-semibold"
              >
                Close
              </button>
            </div>

            <div className="py-4 space-y-4 text-xs leading-relaxed overflow-y-auto max-h-[60vh] pr-1">
              <div>
                <h4 className="font-semibold text-stone-700 dark:text-stone-300 mb-1 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                  100% Offline Local Wi-Fi Pairing
                </h4>
                <p className="text-stone-500 dark:text-stone-400 pl-3">
                  This application communicates directly client-to-client using WebRTC DataChannels. There is zero backend server routing. If you don't have internet access, simply turn on your <strong>phone helper hotspot</strong> and connect both laptop and tablet to it! P2P local lines connects instantly regardless of internet access.
                </p>
              </div>

              <div>
                <h4 className="font-semibold text-stone-700 dark:text-stone-300 mb-1 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                  JEE Digital Desk Configurations
                </h4>
                <p className="text-stone-500 dark:text-stone-400 pl-3">
                  We recommend choosing the <strong>Graph</strong> background template. It behaves exactly like standard mathematical graph paper grids, making sketch mappings of trigonometric graphs, physics kinetics diagrams, and geometry extremely accurate and professional.
                </p>
              </div>

              <div>
                <h4 className="font-semibold text-stone-700 dark:text-stone-300 mb-1 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                  Stylus Pressure Calligraphy
                </h4>
                <p className="text-stone-500 dark:text-stone-400 pl-3">
                  When writing with active Bluetooth Styluses (iPad Apple Pencil, Samsung S-Pen, Microsoft Surface Stylus, Wacom Tablet Pointer), the Pen engine responds to physical pressure. Heavy pressure increases line density, and light sweeps taper edges cleanly matching organic handwriting!
                </p>
              </div>

              <div>
                <h4 className="font-semibold text-stone-700 dark:text-stone-300 mb-1 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                  Stroke Point Eraser
                </h4>
                <p className="text-stone-500 dark:text-stone-400 pl-3">
                  Unlike bitmap pixel rub sweepers, our eraser uses specialized vector intersection math. Shifting the eraser across drawings instantly removes the <strong>intersected vector stroke in its entirety</strong>—making cleaning calculations mistakes extremely fast!
                </p>
              </div>

              <div>
                <h4 className="font-semibold text-stone-700 dark:text-stone-300 mb-1 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                  High-Resolution HD Exporter
                </h4>
                <p className="text-stone-500 dark:text-stone-400 pl-3">
                  Clicking <strong>"Export Page"</strong> scans bounding boxes coordinates across the infinite canvas, maps it cleanly into standard dimensions with surrounding neat padding guidelines, and produces 2x retina HD PNG documents for offline reference.
                </p>
              </div>
            </div>

            <div className="pt-4 border-t border-stone-100 dark:border-stone-800 flex justify-end">
              <button 
                onClick={() => setShowGuideModal(false)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold cursor-pointer transition-colors"
              >
                Let's Study!
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}

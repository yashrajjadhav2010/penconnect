/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Point {
  x: number;       // Coordinate on infinite canvas
  y: number;       // Coordinate on infinite canvas
  p?: number;      // Stylus pressure (0 to 1)
  t: number;       // Timestamp relative to stroke start
}

export interface Stroke {
  id: string;
  points: Point[];
  color: string;
  width: number;
  tool: 'pen' | 'highlighter' | 'eraser';
}

export type ConnectionState =
  | 'idle'
  | 'init-host'      // Host is creating WebRTC peer and generating Offer
  | 'host-offer'      // Host is displaying Offer QR code
  | 'init-joiner'    // Joiner is scanning QR code of Offer
  | 'joiner-answer'   // Joiner has set Offer and generated Answer QR code
  | 'connecting'     // Connecting WebRTC
  | 'connected'      // Fully connected
  | 'failed';

export type DeviceMode = 'unselected' | 'laptop' | 'tablet';

export type PeerMessage =
  | { type: 'sync-request' }
  | { type: 'sync-state'; strokes: Stroke[]; undoStack: Stroke[][]; redoStack: Stroke[][] }
  | { type: 'draw-start'; stroke: Stroke }
  | { type: 'draw-points'; id: string; points: Point[] }
  | { type: 'draw-end'; id: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'clear' }
  | { type: 'ping'; time: number }
  | { type: 'pong'; time: number };

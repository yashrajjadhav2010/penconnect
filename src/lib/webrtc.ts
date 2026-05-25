/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Simple Base64 packing/unpacking helpers to keep QR codes compact
export function encodeSignal(data: { sdp: string; type: 'offer' | 'answer' }): string {
  const json = JSON.stringify(data);
  return btoa(unescape(encodeURIComponent(json)));
}

export function decodeSignal(encoded: string): { sdp: string; type: 'offer' | 'answer' } | null {
  try {
    const json = decodeURIComponent(escape(atob(encoded.trim())));
    return JSON.parse(json);
  } catch (error) {
    console.error('Failed to decode WebRTC signal:', error);
    return null;
  }
}

// Config for PeerConnection
// Include public STUN servers for fallback, but because it is fully local, WebRTC connects instantly over Wi-Fi without internet too!
export const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

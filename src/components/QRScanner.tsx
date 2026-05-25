/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useEffect, useState } from 'react';
import jsQR from 'jsqr';
import { Camera, RefreshCw, XCircle } from 'lucide-react';

interface QRScannerProps {
  onScan: (decodedText: string) => void;
  onClose: () => void;
}

export default function QRScanner({ onScan, onClose }: QRScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [cameraPermissionState, setCameraPermissionState] = useState<'prompt' | 'granted' | 'denied'>('prompt');

  useEffect(() => {
    // Start camera stream on mount
    const startCamera = async () => {
      try {
        setErrorMsg(null);
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
        });
        
        streamRef.current = stream;
        setCameraPermissionState('granted');
        
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          // Important: force play on mobile browsers
          videoRef.current.setAttribute('playsinline', 'true');
          videoRef.current.play().then(() => {
            // Start scanning frames
            animationFrameRef.current = requestAnimationFrame(scanTick);
          }).catch((err) => {
            console.error('Error auto-playing video stream:', err);
          });
        }
      } catch (err: any) {
        console.error('Failed to access camera:', err);
        setCameraPermissionState('denied');
        if (err.name === 'NotAllowedError') {
          setErrorMsg('Camera access was denied. Please allow camera permissions or copy the raw code manually.');
        } else if (err.name === 'NotFoundError') {
          setErrorMsg('No camera hardware found on this device. Please paste the setup code instead.');
        } else {
          setErrorMsg(`Unable to launch camera: ${err.message || 'Unknown error'}`);
        }
      }
    };

    startCamera();

    // Cleanup resources on unmount
    return () => {
      stopCamera();
    };
  }, []);

  const stopCamera = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  const scanTick = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    
    if (video && canvas && video.readyState === video.HAVE_CURRENT_DATA) {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        // Match resolution of the video feeds
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        // Draw video frame on offscreen canvas
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert',
        });

        if (code && code.data) {
          // Success! Play a subtle sound or trigger scan callback
          onScan(code.data);
          stopCamera();
          return; // Stop the animation frame loop
        }
      }
    }
    
    // Continue loop
    animationFrameRef.current = requestAnimationFrame(scanTick);
  };

  return (
    <div className="flex flex-col items-center justify-center p-4 bg-stone-900 border border-stone-800 rounded-2xl shadow-xl overflow-hidden max-w-sm mx-auto text-white">
      <div className="flex items-center justify-between w-full pb-3 border-b border-stone-800 mb-4">
        <div className="flex items-center gap-2">
          <Camera className="w-5 h-5 text-emerald-400 animate-pulse" />
          <span className="font-medium text-stone-100">Live Camera Scanner</span>
        </div>
        <button 
          onClick={onClose}
          className="p-1 hover:bg-stone-800 rounded-full transition-colors"
          title="Close scanner"
        >
          <XCircle className="w-5 h-5 text-stone-400 hover:text-stone-200" />
        </button>
      </div>

      {errorMsg ? (
        <div className="text-center p-6 text-stone-400 text-sm flex flex-col items-center gap-3">
          <p className="text-amber-400 font-medium">Camera Unreachable</p>
          <p className="max-w-[280px] leading-relaxed">{errorMsg}</p>
          <button 
            onClick={onClose}
            className="mt-2 px-4 py-2 bg-stone-800 hover:bg-stone-700 active:bg-stone-650 text-white rounded-xl text-xs transition-colors font-medium cursor-pointer"
          >
            Enter Setup Code Manually
          </button>
        </div>
      ) : (
        <div className="relative w-full aspect-video rounded-xl bg-black border border-stone-800 overflow-hidden">
          {cameraPermissionState === 'prompt' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-sm text-stone-400 gap-3">
              <RefreshCw className="w-6 h-6 text-emerald-400 animate-spin" />
              <span>Requesting camera access...</span>
            </div>
          )}
          
          <video 
            ref={videoRef}
            className="w-full h-full object-cover"
            muted
          />
          
          {/* Subtle guide framing overlay */}
          <div className="absolute inset-0 pointer-events-none border-[12px] border-black/40 flex items-center justify-center">
            <div className="w-36 h-36 border border-emerald-400/80 rounded-xl relative">
              <div className="absolute -top-1 -left-1 w-4 h-4 border-t-2 border-l-2 border-emerald-400 rounded-tl-sm" />
              <div className="absolute -top-1 -right-1 w-4 h-4 border-t-2 border-r-2 border-emerald-400 rounded-tr-sm" />
              <div className="absolute -bottom-1 -left-1 w-4 h-4 border-b-2 border-l-2 border-emerald-400 rounded-bl-sm" />
              <div className="absolute -bottom-1 -right-1 w-4 h-4 border-b-2 border-r-2 border-emerald-400 rounded-br-sm" />
            </div>
          </div>
        </div>
      )}

      {/* Canvas used offscreen for raw camera image analysis */}
      <canvas ref={canvasRef} className="hidden" />

      <p className="text-xs text-stone-400 mt-4 text-center leading-relaxed">
        Align the QR Code of the companion device inside the camera square to connect instantly.
      </p>
    </div>
  );
}

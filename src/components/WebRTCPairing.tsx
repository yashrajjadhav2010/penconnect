/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { 
  Monitor, 
  Tablet, 
  Wifi, 
  WifiOff, 
  Camera, 
  Copy, 
  Check, 
  RefreshCw, 
  ArrowRight, 
  Compass, 
  Info,
  ChevronRight,
  Shield,
  Zap,
  Cpu
} from 'lucide-react';
import { ConnectionState, DeviceMode } from '../types';
import { rtcConfig, encodeSignal, decodeSignal } from '../lib/webrtc';
import QRScanner from './QRScanner';

interface WebRTCPairingProps {
  deviceMode: DeviceMode;
  setDeviceMode: (mode: DeviceMode) => void;
  connectionState: ConnectionState;
  setConnectionState: (state: ConnectionState) => void;
  peerConnectionRef: React.MutableRefObject<RTCPeerConnection | null>;
  dataChannelRef: React.MutableRefObject<RTCDataChannel | null>;
  onDataChannelReady: (channel: RTCDataChannel) => void;
}

export default function WebRTCPairing({
  deviceMode,
  setDeviceMode,
  connectionState,
  setConnectionState,
  peerConnectionRef,
  dataChannelRef,
  onDataChannelReady,
}: WebRTCPairingProps) {
  const [localSignal, setLocalSignal] = useState<string>('');
  const [remoteSignalInput, setRemoteSignalInput] = useState<string>('');
  const [qrUrl, setQrUrl] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const [showScanner, setShowScanner] = useState<boolean>(false);
  const [pairingError, setPairingError] = useState<string | null>(null);

  // Auto PIN pairing states
  const [pin, setPin] = useState<string>('');
  const [inputPin, setInputPin] = useState<string>('');
  const [useBackupManualMode, setUseBackupManualMode] = useState<boolean>(false);
  
  const pollIntervalRef = useRef<any>(null);

  // Clear timers on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      setShowScanner(false);
    };
  }, []);

  // Generate QR code whenever local SDP offer/answer OR PIN updates
  useEffect(() => {
    // If we have a pin, QR code encodes the PIN directly for lightning scan + connect!
    const textToEncode = pin ? pin : localSignal;
    if (textToEncode) {
      QRCode.toDataURL(
        textToEncode, 
        { 
          width: 320, 
          margin: 1, 
          color: { dark: '#000000', light: '#ffffff' } 
        }, 
        (err, url) => {
          if (!err) {
            setQrUrl(url);
          } else {
            console.error('QR code generation error:', err);
          }
        }
      );
    } else {
      setQrUrl('');
    }
  }, [localSignal, pin]);

  // Clean WebRTC resources and timers on role switch or reset
  const resetWebRTC = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    setLocalSignal('');
    setRemoteSignalInput('');
    setPin('');
    setInputPin('');
    setQrUrl('');
    setPairingError(null);
    setConnectionState('idle');
  };

  const handleDeviceSelection = (mode: DeviceMode) => {
    resetWebRTC();
    setDeviceMode(mode);
    if (mode === 'laptop') {
      initializeHost();
    }
  };

  // -------------------------------------------------------------
  // HOST FLOW (Laptop acting as Whiteboard Viewer & Connection Host)
  // -------------------------------------------------------------
  const initializeHost = async () => {
    try {
      resetWebRTC();
      setConnectionState('init-host');
      setPairingError(null);

      const pc = new RTCPeerConnection(rtcConfig);
      peerConnectionRef.current = pc;

      // Handle connection state indicators with fallback WebRTC checks
      const checkConnection = () => {
        console.log('Host connection state change:', pc.connectionState, pc.iceConnectionState);
        if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected') {
          setConnectionState('connected');
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
        } else if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') {
          setConnectionState('failed');
          setPairingError('Local network handshake timed out. Ensure both devices are connected to the same local network subnet.');
        }
      };
      
      pc.onconnectionstatechange = checkConnection;
      pc.oniceconnectionstatechange = checkConnection;

      // Create P2P DataChannel
      const dc = pc.createDataChannel('handwriting-sync', { ordered: true });
      dataChannelRef.current = dc;
      setupDataChannel(dc);

      // Create local SDP offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Gather candidate IP networks safely
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
          return;
        }
        let resolved = false;
        const fallback = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        }, 2200);

        pc.onicecandidate = (e) => {
          if (e.candidate === null) {
            if (!resolved) {
              resolved = true;
              clearTimeout(fallback);
              resolve();
            }
          }
        };
      });

      // Encode host SDP offer
      if (pc.localDescription) {
        const signalText = encodeSignal({
          sdp: pc.localDescription.sdp,
          type: 'offer',
        });
        setLocalSignal(signalText);
        setConnectionState('host-offer');

        // Post offer to backing API to procure a 4-digit PIN!
        try {
          const res = await fetch('/api/pair/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ offer: signalText }),
          });

          if (!res.ok) {
            throw new Error(`Server returned HTTP ${res.status}`);
          }

          const data = await res.json();
          if (data.pin) {
            setPin(data.pin);
            // Poll for Tablet SDP Answer automatically
            startPolling(data.pin);
          } else {
            console.warn('Invalid API PIN response; falling back to manual.');
            setUseBackupManualMode(true);
          }
        } catch (err) {
          console.error('Failed to obtain pairing PIN:', err);
          // Let them copy/scan manually if backend cannot be reached or is pure offline
          setUseBackupManualMode(true);
        }
      }
    } catch (err: any) {
      console.error('Failed to init Host connection:', err);
      setPairingError(`WebRTC Initialization failed: ${err.message || err}`);
      setConnectionState('failed');
    }
  };

  const startPolling = (pairingPin: string) => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/pair/poll?pin=${pairingPin}`);
        if (!res.ok) return;

        const data = await res.json();
        if (data.answer) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
          handleResponseFromJoiner(data.answer);
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 1200);
  };

  const handleResponseFromJoiner = async (answerSignal: string) => {
    try {
      setPairingError(null);
      const decoded = decodeSignal(answerSignal);
      if (!decoded || decoded.type !== 'answer') {
        setPairingError('Invalid WebRTC answer. Make sure you scanned the Tablet hand-shake screen.');
        return;
      }

      if (!peerConnectionRef.current) {
        setPairingError('Pairing connection was closed. Please select Laptop Mode again.');
        return;
      }

      setConnectionState('connecting');
      await peerConnectionRef.current.setRemoteDescription(
        new RTCSessionDescription({
          sdp: decoded.sdp,
          type: 'answer',
        })
      );
    } catch (err: any) {
      console.error('Failed to apply Answer SDP:', err);
      setPairingError(`Manual handshake failed: ${err.message || err}`);
      setConnectionState('host-offer');
    }
  };

  // -------------------------------------------------------------
  // JOINER FLOW (Tablet acting as Smart Drawing Pad & Connection Joiner)
  // -------------------------------------------------------------
  const connectWithPin = async (pairingPin: string) => {
    const trimmedPin = pairingPin.trim();
    if (trimmedPin.length !== 4) return;

    setPairingError(null);
    setConnectionState('init-joiner');

    try {
      // 1. Download Laptop's Offer by PIN
      const res = await fetch(`/api/pair/get?pin=${trimmedPin}`);
      if (!res.ok) {
        throw new Error('Incorrect, expired, or non-active PIN. Please verify the code displayed on your Laptop.');
      }
      
      const data = await res.json();
      if (!data.offer) {
        throw new Error('Offer signal structure empty.');
      }

      const decoded = decodeSignal(data.offer);
      if (!decoded || decoded.type !== 'offer') {
        throw new Error('Signal packet is corrupt or mismatched.');
      }

      // 2. Build local RTCPeerConnection
      const pc = new RTCPeerConnection(rtcConfig);
      peerConnectionRef.current = pc;

      const checkConnection = () => {
        console.log('Joiner connection state change:', pc.connectionState, pc.iceConnectionState);
        if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected') {
          setConnectionState('connected');
        } else if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') {
          setConnectionState('failed');
          setPairingError('Handshake timed out. Ensure both devices are on the same local subnet.');
        }
      };
      
      pc.onconnectionstatechange = checkConnection;
      pc.oniceconnectionstatechange = checkConnection;

      // Map incoming laptop communications lane
      pc.ondatachannel = (e) => {
        const dc = e.channel;
        dataChannelRef.current = dc;
        setupDataChannel(dc);
      };

      // Set host offer SDP remote parameters
      await pc.setRemoteDescription(
        new RTCSessionDescription({
          sdp: decoded.sdp,
          type: 'offer',
        })
      );

      // Create answer descriptors
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Wait for local interface descriptors to resolve
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
          return;
        }
        let resolved = false;
        const fallback = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        }, 2200);

        pc.onicecandidate = (e) => {
          if (e.candidate === null) {
            if (!resolved) {
              resolved = true;
              clearTimeout(fallback);
              resolve();
            }
          }
        };
      });

      // Submit encoded answer to server registry!
      if (pc.localDescription) {
        const signalText = encodeSignal({
          sdp: pc.localDescription.sdp,
          type: 'answer',
        });
        setLocalSignal(signalText);

        const replyRes = await fetch('/api/pair/answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: trimmedPin, answer: signalText }),
        });

        if (!replyRes.ok) {
          throw new Error('Unable to send remote description answer back to Laptop.');
        }

        setConnectionState('connecting');
      }
    } catch (err: any) {
      console.error('PIN connecting procedure crashed:', err);
      setPairingError(err.message || 'Connecting with PIN failed.');
      setConnectionState('idle');
    }
  };

  const handleOfferFromHost = async (offerSignal: string) => {
    try {
      setPairingError(null);
      const decoded = decodeSignal(offerSignal);
      if (!decoded || decoded.type !== 'offer') {
        setPairingError('Invalid signal. Make sure you are scanning the LAPTOP screen QR code.');
        return;
      }

      setConnectionState('init-joiner');
      const pc = new RTCPeerConnection(rtcConfig);
      peerConnectionRef.current = pc;

      const checkConnection = () => {
        console.log('Joiner connection state change:', pc.connectionState, pc.iceConnectionState);
        if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected') {
          setConnectionState('connected');
        } else if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') {
          setConnectionState('failed');
          setPairingError('Handshake failure. Please restart pairing.');
        }
      };
      
      pc.onconnectionstatechange = checkConnection;
      pc.oniceconnectionstatechange = checkConnection;

      pc.ondatachannel = (e) => {
        const dc = e.channel;
        dataChannelRef.current = dc;
        setupDataChannel(dc);
      };

      await pc.setRemoteDescription(
        new RTCSessionDescription({
          sdp: decoded.sdp,
          type: 'offer',
        })
      );

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      if (pc.iceGatheringState !== 'complete') {
        await new Promise<void>((resolve) => {
          const checkGathering = () => {
            if (pc.iceGatheringState === 'complete') {
              pc.removeEventListener('icegatheringstatechange', checkGathering);
              resolve();
            }
          };
          pc.addEventListener('icegatheringstatechange', checkGathering);
          setTimeout(resolve, 2500);
        });
      }

      if (pc.localDescription) {
        const signalText = encodeSignal({
          sdp: pc.localDescription.sdp,
          type: 'answer',
        });
        setLocalSignal(signalText);
        setConnectionState('joiner-answer');
      }
    } catch (err: any) {
      console.error('Failed to apply offer and generate answer:', err);
      setPairingError(`Matching Host offer failed: ${err.message || err}`);
      setConnectionState('idle');
    }
  };

  // Setup core data channel
  const setupDataChannel = (dc: RTCDataChannel) => {
    dc.onopen = () => {
      console.log('SYNC DataChannel successfully connected and open!');
      setConnectionState('connected');
      onDataChannelReady(dc);
    };

    dc.onclose = () => {
      console.log('SYNC DataChannel closed.');
      setConnectionState('idle');
    };

    dc.onerror = (err) => {
      console.error('SYNC DataChannel error:', err);
    };
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const executeQRScan = (text: string) => {
    setShowScanner(false);
    const cleaned = text.trim();
    if (deviceMode === 'tablet') {
      // If result is 4-digit PIN, immediately use automatic PIN pairing!
      if (cleaned.length === 4 && /^\d+$/.test(cleaned)) {
        setInputPin(cleaned);
        connectWithPin(cleaned);
      } else {
        // Fallback to manual signal decoding if they scanned manual QR
        handleOfferFromHost(cleaned);
      }
    } else if (deviceMode === 'laptop') {
      handleResponseFromJoiner(cleaned);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[85vh] px-4 py-8 bg-stone-50 select-none">
      
      {/* Intro Header */}
      <div className="text-center max-w-xl mb-8">
        <h1 className="text-3xl font-sans font-semibold tracking-tight text-stone-800 flex items-center justify-center gap-3">
          <Wifi className="w-8 h-8 text-indigo-600 animate-pulse" />
          Handwriting Sync
        </h1>
        <p className="text-stone-500 text-sm mt-3 leading-relaxed">
          JEE Study Desk: Broadcast your stylus strokes live from a touch tablet securely to your laptop screen with zero lag. Zero typing required on your laptop!
        </p>
      </div>

      {pairingError && (
        <div className="w-full max-w-md p-4 mb-6 bg-red-50 border border-red-100 rounded-xl text-red-700 text-xs leading-relaxed flex items-start gap-3">
          <Info className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">Pairing Fail:</span> {pairingError}
          </div>
        </div>
      )}

      {/* STEP 1: Select Role */}
      {deviceMode === 'unselected' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-2xl">
          {/* LAPTOP / DISPLAY MODE */}
          <div 
            onClick={() => handleDeviceSelection('laptop')}
            className="group flex flex-col items-center justify-center p-8 bg-white border border-stone-200 hover:border-indigo-500 rounded-2xl shadow-sm hover:shadow-md cursor-pointer transition-all duration-300 transform hover:-translate-y-1 text-center"
          >
            <div className="p-4 bg-indigo-50 group-hover:bg-indigo-100 text-indigo-600 rounded-2xl mb-5 transition-colors">
              <Monitor className="w-10 h-10" />
            </div>
            <h3 className="font-semibold text-stone-800 text-lg">Laptop Mode</h3>
            <p className="text-xs text-stone-400 mt-2 max-w-[220px]">
              Acts as the <strong>Live Whiteboard Viewer</strong>. Shows your drawings in real-time.
            </p>
            <div className="text-indigo-600 text-xs font-semibold mt-4 flex items-center gap-1 group-hover:translate-x-1 transition-transform">
              Open Board Viewer <ChevronRight className="w-4 h-4" />
            </div>
          </div>

          {/* TABLET / DRAW MODE */}
          <div 
            onClick={() => handleDeviceSelection('tablet')}
            className="group flex flex-col items-center justify-center p-8 bg-white border border-stone-200 hover:border-teal-500 rounded-2xl shadow-sm hover:shadow-md cursor-pointer transition-all duration-300 transform hover:-translate-y-1 text-center"
          >
            <div className="p-4 bg-teal-50 group-hover:bg-teal-100 text-teal-600 rounded-2xl mb-5 transition-colors">
              <Tablet className="w-10 h-10" />
            </div>
            <h3 className="font-semibold text-stone-800 text-lg">Tablet Mode</h3>
            <p className="text-xs text-stone-400 mt-2 max-w-[220px]">
              Acts as your <strong>Stylus Drawing Pad</strong>. Features palm-rejection and latency optimization.
            </p>
            <div className="text-teal-600 text-xs font-semibold mt-4 flex items-center gap-1 group-hover:translate-x-1 transition-transform">
              Start Writing <ChevronRight className="w-4 h-4" />
            </div>
          </div>
        </div>
      )}

      {/* LAPTOP VIEW & POLL PAIRING CONTROLS */}
      {deviceMode === 'laptop' && (
        <div className="w-full max-w-md bg-white border border-stone-200 rounded-2xl shadow-lg p-6">
          <div className="flex items-center justify-between pb-4 border-b border-stone-100 mb-6">
            <span className="text-xs font-semibold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full uppercase tracking-wider flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5" /> Laptop Viewport
            </span>
            <button 
              onClick={() => handleDeviceSelection('unselected')}
              className="text-xs text-stone-400 hover:text-stone-700 cursor-pointer underline decoration-dotted capitalize"
            >
              Reset Role
            </button>
          </div>

          {connectionState === 'init-host' && (
            <div className="flex flex-col items-center justify-center py-10 gap-4 text-stone-500 text-sm">
              <RefreshCw className="w-8 h-8 text-indigo-500 animate-spin" />
              <span>Initializing secure pairing desk...</span>
            </div>
          )}

          {connectionState === 'host-offer' && (
            <div className="flex flex-col items-center">
              
              {!useBackupManualMode ? (
                // MODERN NO-TYPE AUTOMATED FLOW
                <div className="w-full flex flex-col items-center text-center">
                  <div className="inline-flex items-center justify-center gap-1 text-xs text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-full font-semibold mb-4 border border-emerald-100 animate-pulse">
                    <Zap className="w-3 h-3 fill-emerald-600" /> Pairing Code Active
                  </div>
                  
                  <h4 className="font-sans font-bold text-stone-800 text-sm mb-1">Enter Code on Tablet</h4>
                  <p className="text-xs text-stone-400 mb-5 max-w-xs leading-normal">
                    Enter the code or scan the QR below with your Tablet's camera to connect both devices instantly.
                  </p>

                  {/* LARGE HIGH-CONTRAST DIGITAL PIN */}
                  {pin ? (
                    <div className="flex justify-center gap-2 mb-6">
                      {pin.split('').map((char, index) => (
                        <div key={index} className="w-12 h-14 bg-stone-900 text-amber-500 font-mono text-3xl font-bold rounded-xl flex items-center justify-center shadow-lg border-b-2 border-stone-950">
                          {char}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="w-full py-4 text-xs font-medium text-stone-400 flex items-center justify-center gap-2">
                      <RefreshCw className="w-4 h-4 animate-spin" /> Registering code...
                    </div>
                  )}

                  {/* QR CODE BLOCK CHANGER */}
                  {qrUrl ? (
                    <div className="p-3 bg-white border border-stone-150 rounded-2xl shadow-inner mb-6 transition-all duration-300 transform">
                      <img 
                        src={qrUrl} 
                        alt="Join PIN code" 
                        referrerPolicy="no-referrer"
                        className="w-44 h-44 block" 
                      />
                    </div>
                  ) : (
                    <div className="w-44 h-44 bg-stone-50 rounded-xl mb-6 border animate-pulse flex items-center justify-center text-xs text-stone-300">
                      QR Code Loading...
                    </div>
                  )}

                  <div className="w-full flex items-center gap-2 py-1 text-stone-200">
                    <hr className="flex-1" />
                    <span className="text-[10px] uppercase tracking-wider text-stone-400 font-semibold">Waiting for device connection</span>
                    <hr className="flex-1" />
                  </div>

                  <button 
                    onClick={() => setUseBackupManualMode(true)}
                    className="text-xs text-stone-400 hover:text-indigo-600 cursor-pointer underline transition-all mt-4 font-medium"
                  >
                    Use original manual copy-paste instead
                  </button>
                </div>
              ) : (
                // BACKUP ORIGINAL WEB-RTC SIGNAL SWAP (Offline Air-gapped backports)
                <div className="w-full flex flex-col items-center">
                  <span className="text-xs font-semibold text-amber-600 bg-amber-50 border border-amber-100 px-2.5 py-0.5 rounded-full mb-3">
                    🔧 Standalone WebRTC (No Router Server)
                  </span>

                  <h4 className="font-semibold text-stone-800 text-sm mb-1 text-center">Swap Signal Profiles</h4>
                  <p className="text-xs text-stone-400 text-center mb-5 max-w-xs leading-normal">
                    Copy the Laptop Offer string below, deliver it to your Tablet, then paste the Tablet Answer back.
                  </p>

                  {/* RENDER DYNAMIC OFFER QR CODE */}
                  {qrUrl ? (
                    <div className="p-3 bg-white border rounded-xl shadow-inner mb-4">
                      <img 
                        src={qrUrl} 
                        alt="Local SDP Offer" 
                        referrerPolicy="no-referrer"
                        className="w-48 h-48 block" 
                      />
                    </div>
                  ) : (
                    <div className="w-48 h-48 bg-stone-50 rounded-xl mb-4 border animate-pulse flex items-center justify-center text-xs text-stone-400">
                      Rendering Offer...
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => copyToClipboard(localSignal)}
                    className="w-full flex items-center justify-center gap-2 py-2 px-4 bg-stone-50 border border-stone-200 text-stone-700 hover:bg-stone-100 rounded-xl text-xs font-semibold transition-all mb-4 cursor-pointer"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? 'Copied Offer!' : 'Copy Laptop Offer String'}
                  </button>

                  <div className="w-full border-t border-stone-100 pt-4">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="font-semibold text-stone-800 text-xs">Step 2: Submit Tablet Answer</h4>
                      <button 
                        onClick={() => setShowScanner(prev => !prev)}
                        className="flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800 font-semibold cursor-pointer"
                      >
                        <Camera className="w-4 h-4" />
                        Scan Tablet
                      </button>
                    </div>

                    {showScanner ? (
                      <QRScanner 
                        onScan={(val) => {
                          setRemoteSignalInput(val);
                          handleResponseFromJoiner(val);
                        }} 
                        onClose={() => setShowScanner(false)} 
                      />
                    ) : (
                      <div className="flex flex-col gap-2">
                        <textarea
                          placeholder="Paste the Base64 ANSWER code generated on your Tablet..."
                          value={remoteSignalInput}
                          onChange={(e) => {
                            setRemoteSignalInput(e.target.value);
                            if (e.target.value.trim().length > 100) {
                              handleResponseFromJoiner(e.target.value);
                            }
                          }}
                          className="w-full text-xs font-mono p-3 border border-stone-200 rounded-xl bg-stone-50 h-16 outline-none focus:border-indigo-500 focus:bg-white resize-none transition-all placeholder:text-stone-300"
                        />
                        <button
                          disabled={!remoteSignalInput.trim()}
                          onClick={() => handleResponseFromJoiner(remoteSignalInput)}
                          className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-stone-200 text-white font-semibold text-xs rounded-xl cursor-pointer"
                        >
                          Establish WebRTC Connection
                        </button>
                      </div>
                    )}
                  </div>

                  <button 
                    onClick={() => setUseBackupManualMode(false)}
                    className="text-[11px] text-stone-400 hover:text-stone-600 cursor-pointer underline mt-3.5 block"
                  >
                    Return to Automated Code Pairing
                  </button>
                </div>
              )}

            </div>
          )}

          {connectionState === 'connecting' && (
            <div className="flex flex-col items-center justify-center py-12 text-center text-stone-500 gap-4">
              <RefreshCw className="w-10 h-10 text-indigo-500 animate-spin" />
              <span className="font-semibold text-stone-800 text-sm">Negotiating offline handshake...</span>
              <p className="text-xs text-stone-400 max-w-xs leading-relaxed">
                Opening high-speed stylus data lane. Wait a microsecond.
              </p>
            </div>
          )}
        </div>
      )}

      {/* TABLET PAIRING CONTROLS */}
      {deviceMode === 'tablet' && (
        <div className="w-full max-w-md bg-white border border-stone-200 rounded-2xl shadow-lg p-6">
          <div className="flex items-center justify-between pb-4 border-b border-stone-100 mb-6 font-sans">
            <span className="text-xs font-semibold text-teal-600 bg-teal-50 px-2.5 py-1 rounded-full uppercase tracking-wider flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5" /> Tablet Stylus Pad
            </span>
            <button 
              onClick={() => handleDeviceSelection('unselected')}
              className="text-xs text-stone-400 hover:text-stone-700 cursor-pointer underline decoration-dotted"
            >
              Reset Role
            </button>
          </div>

          {connectionState === 'idle' && (
            <div className="flex flex-col items-center">
              
              {!useBackupManualMode ? (
                // MODERN NO-TYPE PAIRING ROUTINES
                <div className="w-full flex flex-col items-center">
                  <h4 className="font-serif font-bold text-stone-800 text-sm mb-1 text-center font-sans">Enter Laptop Pairing PIN</h4>
                  <p className="text-xs text-stone-400 text-center mb-5 max-w-xs leading-normal">
                    Check your Laptop's viewport and input the active 4-digit code below to establish connection instantly.
                  </p>

                  {/* 4-DIGIT PIN TYPING INPUTS */}
                  <div className="w-full flex justify-center gap-3.5 mb-6">
                    <input
                      type="text"
                      maxLength={4}
                      pattern="\d*"
                      placeholder="0000"
                      value={inputPin}
                      onChange={(e) => {
                        const val = e.target.value.replace(/\D/g, '').slice(0, 4);
                        setInputPin(val);
                        if (val.length === 4) {
                          connectWithPin(val);
                        }
                      }}
                      className="w-48 py-3 text-center tracking-[1.5em] pl-[1.5em] font-mono text-3xl font-extrabold text-stone-800 bg-stone-50 border-2 border-stone-200 outline-none rounded-xl focus:border-teal-500 focus:bg-white resize-none transition-all duration-300"
                    />
                  </div>

                  <button
                    disabled={inputPin.length !== 4}
                    onClick={() => connectWithPin(inputPin)}
                    className="w-full mb-4 py-2.5 bg-teal-600 hover:bg-teal-700 disabled:bg-stone-200 disabled:text-stone-400 disabled:cursor-not-allowed shadow flex items-center justify-center gap-2 text-white font-semibold text-xs rounded-xl cursor-pointer transition-all font-sans"
                  >
                    Connect with PIN <ArrowRight className="w-3.5 h-3.5" />
                  </button>

                  <div className="w-full flex items-center gap-2 my-2.5 text-stone-200">
                    <hr className="flex-1" />
                    <span className="text-[10px] font-bold uppercase tracking-widest text-stone-400">OR SCAN SCREEN</span>
                    <hr className="flex-1" />
                  </div>

                  {/* SCAN LAPTOP BUTTON */}
                  <button
                    onClick={() => {
                      setPairingError(null);
                      setShowScanner(true);
                    }}
                    className="w-full mb-4 py-2.5 bg-stone-800 hover:bg-stone-900 border text-white font-semibold text-xs rounded-xl flex items-center justify-center gap-1.5 transition-all cursor-pointer font-sans shadow-sm"
                  >
                    <Camera className="w-4 h-4 text-emerald-400" />
                    Scan Laptop Screen QR Code
                  </button>

                  {showScanner && (
                    <div className="w-full mb-4">
                      <QRScanner 
                        onScan={executeQRScan} 
                        onClose={() => setShowScanner(false)} 
                      />
                    </div>
                  )}

                  <button 
                    onClick={() => setUseBackupManualMode(true)}
                    className="text-xs text-stone-400 hover:text-teal-600 cursor-pointer underline transition-all mt-4 font-medium"
                  >
                    Use original manual copy-paste instead
                  </button>
                </div>
              ) : (
                // BACKUP MANUAL SDP COPY MODE
                <div className="w-full flex flex-col items-center">
                  <span className="text-xs font-semibold text-amber-600 bg-amber-50 border border-amber-105 px-2.5 py-0.5 rounded-full mb-3">
                    🔧 Standalone WebRTC (No Router Server)
                  </span>

                  <h4 className="font-semibold text-stone-800 text-sm mb-1 text-center">Scan Laptop Code</h4>
                  <p className="text-xs text-stone-400 text-center mb-5 max-w-xs leading-normal">
                    Scan the QR code displaying on the Laptop screen to process remote handshakes.
                  </p>

                  <button
                    onClick={() => setShowScanner(true)}
                    className="w-full mb-3 py-2.5 bg-teal-600 hover:bg-teal-700 shadow flex items-center justify-center gap-2 text-white font-semibold text-xs rounded-xl cursor-pointer transition-all"
                  >
                    <Camera className="w-4 h-4" />
                    Scan Laptop Code
                  </button>

                  {showScanner && (
                    <div className="w-full mb-4">
                      <QRScanner 
                        onScan={executeQRScan} 
                        onClose={() => setShowScanner(false)} 
                      />
                    </div>
                  )}

                  <div className="w-full flex items-center gap-2 my-2 text-stone-200">
                    <hr className="flex-1" />
                    <span className="text-[9px] font-semibold text-stone-400 uppercase tracking-widest">Manual Text Import</span>
                    <hr className="flex-1" />
                  </div>

                  <textarea
                    placeholder="Paste the Base64 Laptop Offer code here..."
                    value={remoteSignalInput}
                    onChange={(e) => {
                      setRemoteSignalInput(e.target.value);
                      if (e.target.value.trim().length > 100) {
                        handleOfferFromHost(e.target.value);
                      }
                    }}
                    className="w-full text-xs font-mono p-3 border border-stone-200 rounded-xl bg-stone-50 h-16 outline-none focus:border-teal-500 focus:bg-white resize-none transition-all placeholder:text-stone-300"
                  />
                  <button
                    disabled={!remoteSignalInput.trim()}
                    onClick={() => handleOfferFromHost(remoteSignalInput)}
                    className="w-full mt-2 py-2 bg-stone-800 disabled:bg-stone-150 text-white font-semibold text-xs rounded-xl cursor-pointer"
                  >
                    Apply Laptop Offer
                  </button>

                  <button 
                    onClick={() => setUseBackupManualMode(false)}
                    className="text-[11px] text-stone-400 hover:text-stone-600 cursor-pointer underline mt-4 block"
                  >
                    Return to Automated Code Pairing
                  </button>
                </div>
              )}

            </div>
          )}

          {connectionState === 'init-joiner' && (
            <div className="flex flex-col items-center justify-center py-10 gap-4 text-stone-500 text-sm">
              <RefreshCw className="w-8 h-8 text-teal-500 animate-spin" />
              <span>Matching Laptop profiles and registering Answer...</span>
            </div>
          )}

          {connectionState === 'joiner-answer' && (
            <div className="flex flex-col items-center">
              <span className="text-xs font-semibold text-amber-600 bg-amber-50 border border-amber-105 px-2.5 py-0.5 rounded-full mb-3">
                🔧 Submit Response to Laptop
              </span>
              <p className="text-xs text-stone-400 text-center mb-5 max-w-xs leading-normal">
                Laptop camera can scan the QR code answering block below, or copy the string to paste into Step 2 inputs on Laptop.
              </p>

              {/* ANSWER DYNAMIC QR CODE */}
              {qrUrl ? (
                <div className="p-3 bg-white border rounded-xl shadow-inner mb-4">
                  <img 
                    src={qrUrl} 
                    alt="Answer SDP QR" 
                    className="w-48 h-48 block" 
                    referrerPolicy="no-referrer"
                  />
                </div>
              ) : (
                <div className="w-48 h-48 bg-stone-50 rounded-xl mb-4 border animate-pulse flex items-center justify-center text-xs text-stone-400">
                  Rendering Answer...
                </div>
              )}

              <button
                type="button"
                onClick={() => copyToClipboard(localSignal)}
                className="w-full flex items-center justify-center gap-2 py-2 px-4 bg-stone-50 border border-stone-200 text-stone-700 hover:bg-stone-100 rounded-xl text-xs font-semibold transition-all cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied Answer!' : 'Copy Answer String'}
              </button>
            </div>
          )}

          {connectionState === 'connecting' && (
            <div className="flex flex-col items-center justify-center py-12 text-center text-stone-500 gap-4">
              <RefreshCw className="w-10 h-10 text-teal-500 animate-spin" />
              <span className="font-semibold text-stone-800 text-sm font-sans">Handshaking peer-to-peer...</span>
            </div>
          )}
        </div>
      )}

      {/* OFFLINE DESK GUIDES */}
      <div className="flex items-center gap-5 mt-8 p-4 max-w-md bg-stone-150/40 rounded-xl border border-stone-150 text-[11px] text-stone-500 leading-relaxed font-sans shadow-sm">
        <Compass className="w-8 h-8 text-indigo-500 shrink-0" />
        <div>
          <span className="font-semibold text-stone-700 block mb-0.5">Automated local/offline sync network context:</span> 
          Using the pairing server of this integrated dashboard, devices are matched safely. If both devices are on the same local subnet (connected to same Wi-Fi hub or hot-spot), they connect peer-to-peer instantly.
        </div>
      </div>

    </div>
  );
}

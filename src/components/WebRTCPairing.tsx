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
  ChevronRight
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

  // Stop camera if user leaves screen
  useEffect(() => {
    return () => {
      setShowScanner(false);
    };
  }, []);

  // Generate QR code whenever local SDP offer/answer signal string updates
  useEffect(() => {
    if (localSignal) {
      QRCode.toDataURL(localSignal, { width: 320, margin: 1, color: { dark: '#000000', light: '#ffffff' } }, (err, url) => {
        if (!err) {
          setQrUrl(url);
        } else {
          console.error('QR code generation error:', err);
        }
      });
    } else {
      setQrUrl('');
    }
  }, [localSignal]);

  // Clean peer-connection resource leaks on role-switch
  const resetWebRTC = () => {
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

      // Handle connection state indicators
      pc.onconnectionstatechange = () => {
        console.log('Host connection state change:', pc.connectionState);
        if (pc.connectionState === 'connected') {
          setConnectionState('connected');
        } else if (pc.connectionState === 'failed') {
          setConnectionState('failed');
          setPairingError('Local network handshake timed out. Ensure both devices are on the same Wi-Fi subnet.');
        }
      };

      // Create P2P DataChannel
      const dc = pc.createDataChannel('handwriting-sync', { ordered: true });
      dataChannelRef.current = dc;
      setupDataChannel(dc);

      // Create local SDP offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Disable trickling ICE candidates: wait for all local interface candidates 
      // to resolve into the SDP block BEFORE showing the connection code.
      if (pc.iceGatheringState !== 'complete') {
        await new Promise<void>((resolve) => {
          const checkGathering = () => {
            if (pc.iceGatheringState === 'complete') {
              pc.removeEventListener('icegatheringstatechange', checkGathering);
              resolve();
            }
          };
          pc.addEventListener('icegatheringstatechange', checkGathering);
          // Safety timeout
          setTimeout(resolve, 2500);
        });
      }

      // Encode Host Offer
      if (pc.localDescription) {
        const signalText = encodeSignal({
          sdp: pc.localDescription.sdp,
          type: 'offer',
        });
        setLocalSignal(signalText);
        setConnectionState('host-offer');
      }
    } catch (err: any) {
      console.error('Failed to init Host connection:', err);
      setPairingError(`WebRTC Initialization failed: ${err.message || err}`);
      setConnectionState('failed');
    }
  };

  const handleResponseFromJoiner = async (answerSignal: string) => {
    try {
      setPairingError(null);
      const decoded = decodeSignal(answerSignal);
      if (!decoded || decoded.type !== 'answer') {
        setPairingError('Invalid signal signature. Please make sure you copy/scanned the tablet ANSWER string.');
        return;
      }

      if (!peerConnectionRef.current) {
        setPairingError('Connection state was reset. Please start the pairing steps again.');
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
      console.error('Failed to apply Answer:', err);
      setPairingError(`Could not establish session matching tablet: ${err.message || err}`);
      setConnectionState('host-offer');
    }
  };

  // -------------------------------------------------------------
  // JOINER FLOW (Tablet acting as Smart Drawing Pad & Connection Joiner)
  // -------------------------------------------------------------
  const handleOfferFromHost = async (offerSignal: string) => {
    try {
      setPairingError(null);
      const decoded = decodeSignal(offerSignal);
      if (!decoded || decoded.type !== 'offer') {
        setPairingError('Invalid signal code. Ensure you are scanning the LAPTOP screen QR code.');
        return;
      }

      setConnectionState('init-joiner');
      const pc = new RTCPeerConnection(rtcConfig);
      peerConnectionRef.current = pc;

      pc.onconnectionstatechange = () => {
        console.log('Joiner connection state change:', pc.connectionState);
        if (pc.connectionState === 'connected') {
          setConnectionState('connected');
        } else if (pc.connectionState === 'failed') {
          setConnectionState('failed');
          setPairingError('Handshake failure. Please restart pairing.');
        }
      };

      // Listen for Host-provisioned DataChannel
      pc.ondatachannel = (e) => {
        const dc = e.channel;
        dataChannelRef.current = dc;
        setupDataChannel(dc);
      };

      // Apply Host SDP Offer
      await pc.setRemoteDescription(
        new RTCSessionDescription({
          sdp: decoded.sdp,
          type: 'offer',
        })
      );

      // Create tablet local SDP answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Wait for local IP/port interfaces candidate gathering
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

      // Encode Joiner Answer
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

  // Core DataChannel event bindings
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

  // Helper copy to dashboard
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const executeQRScan = (text: string) => {
    setShowScanner(false);
    if (deviceMode === 'tablet') {
      handleOfferFromHost(text);
    } else if (deviceMode === 'laptop') {
      handleResponseFromJoiner(text);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[80vh] px-4 py-8 bg-stone-50 select-none">
      
      {/* Intro Header */}
      <div className="text-center max-w-xl mb-10">
        <h1 className="text-3xl font-sans font-semibold tracking-tight text-stone-800 flex items-center justify-center gap-3">
          <Wifi className="w-8 h-8 text-indigo-600" />
          Handwriting Sync
        </h1>
        <p className="text-stone-500 text-sm mt-3 leading-relaxed">
          JEE Study Desk: Broadcast your stylus strokes live from a touch tablet securely to a large laptop screen with zero-delay WebRTC peer-to-peer data lines. Fully offline!
        </p>
      </div>

      {pairingError && (
        <div className="w-full max-w-lg p-4 mb-6 bg-red-50 border border-red-100 rounded-xl text-red-700 text-xs leading-relaxed flex items-start gap-3">
          <Info className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">Pairing Error:</span> {pairingError}
          </div>
        </div>
      )}

      {/* STEP 1: Select Role */}
      {deviceMode === 'unselected' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-2xl">
          {/* HOST / LAPTOP PORT */}
          <div 
            onClick={() => handleDeviceSelection('laptop')}
            className="group flex flex-col items-center justify-center p-8 bg-white border border-stone-200 hover:border-indigo-500 rounded-2xl shadow-sm hover:shadow-md cursor-pointer transition-all duration-300 transform hover:-translate-y-1 text-center"
          >
            <div className="p-4 bg-indigo-50 group-hover:bg-indigo-100 text-indigo-600 rounded-2xl mb-5 transition-colors">
              <Monitor className="w-10 h-10" />
            </div>
            <h3 className="font-semibold text-stone-800 text-lg">Laptop Mode</h3>
            <p className="text-xs text-stone-400 mt-2 max-w-[220px]">
              Acts as the <strong>Live Whiteboard Viewer</strong>. Generates connection offer codes.
            </p>
            <div className="text-indigo-600 text-xs font-semibold mt-4 flex items-center gap-1 group-hover:translate-x-1 transition-transform">
              Start Viewing <ChevronRight className="w-4 h-4" />
            </div>
          </div>

          {/* SENDER / TABLET PORT */}
          <div 
            onClick={() => handleDeviceSelection('tablet')}
            className="group flex flex-col items-center justify-center p-8 bg-white border border-stone-200 hover:border-indigo-500 rounded-2xl shadow-sm hover:shadow-md cursor-pointer transition-all duration-300 transform hover:-translate-y-1 text-center"
          >
            <div className="p-4 bg-teal-50 group-hover:bg-teal-100 text-teal-600 rounded-2xl mb-5 transition-colors">
              <Tablet className="w-10 h-10" />
            </div>
            <h3 className="font-semibold text-stone-800 text-lg">Tablet Mode</h3>
            <p className="text-xs text-stone-400 mt-2 max-w-[220px]">
              Acts as the <strong>Stylus Pen Pad</strong>. Scans laptop code and draws with full palm-rejection.
            </p>
            <div className="text-teal-600 text-xs font-semibold mt-4 flex items-center gap-1 group-hover:translate-x-1 transition-transform">
              Start Writing <ChevronRight className="w-4 h-4" />
            </div>
          </div>
        </div>
      )}

      {/* LAPTOP FLOW CONTROLS */}
      {deviceMode === 'laptop' && (
        <div className="w-full max-w-lg bg-white border border-stone-200 rounded-2xl shadow-lg p-6">
          <div className="flex items-center justify-between pb-4 border-b border-stone-100 mb-6">
            <span className="text-xs font-semibold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full uppercase tracking-wider">
              Step 1 of 2: Laptop (Viewer Host)
            </span>
            <button 
              onClick={() => handleDeviceSelection('unselected')}
              className="text-xs text-stone-500 hover:text-stone-700 cursor-pointer underline decoration-dotted capitalize"
            >
              Reset Role
            </button>
          </div>

          {/* Creating local environment offers */}
          {connectionState === 'init-host' && (
            <div className="flex flex-col items-center justify-center py-10 gap-4 text-stone-500 text-sm">
              <RefreshCw className="w-8 h-8 text-indigo-500 animate-spin" />
              <span>Configuring secure offline WebRTC interfaces...</span>
            </div>
          )}

          {connectionState === 'host-offer' && (
            <div className="flex flex-col items-center">
              <h4 className="font-semibold text-stone-800 text-sm mb-1 text-center">Scan QR Code on Tablet</h4>
              <p className="text-xs text-stone-400 text-center mb-5 max-w-xs leading-normal">
                Open this app on your tablet, choose "Tablet Mode", and scan the QR code below using the tablet camera.
              </p>

              {/* RENDER DYNAMIC OFFER QR CODE */}
              {qrUrl ? (
                <div className="p-3 bg-white border-2 border-stone-100 rounded-xl shadow-inner mb-6">
                  <img 
                    src={qrUrl} 
                    alt="Host WebRTC Offer Code" 
                    referrerPolicy="no-referrer"
                    className="w-52 h-52 block" 
                  />
                </div>
              ) : (
                <div className="w-52 h-52 bg-stone-50 rounded-xl mb-6 border animate-pulse flex items-center justify-center text-xs text-stone-400">
                  Rendering code...
                </div>
              )}

              {/* Action utilities */}
              <div className="flex gap-2 w-full mb-6">
                <button
                  type="button"
                  onClick={() => copyToClipboard(localSignal)}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 bg-stone-50 border border-stone-200 text-stone-700 hover:bg-stone-100 rounded-xl text-xs font-semibold transition-all cursor-pointer"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied Offer!' : 'Copy Code String'}
                </button>
              </div>

              {/* STEP 2 FOR HOST: PASTE TABLET ANSWER */}
              <div className="w-full border-t border-stone-100 pt-5 mt-3">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-semibold text-stone-800 text-xs">Step 2: Connect Tablet back</h4>
                  <button 
                    onClick={() => setShowScanner(prev => !prev)}
                    className="flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800 font-semibold cursor-pointer"
                  >
                    <Camera className="w-4 h-4" />
                    Scan Tablet Screen
                  </button>
                </div>

                {showScanner ? (
                  <div className="mb-4">
                    <QRScanner 
                      onScan={(val) => {
                        setRemoteSignalInput(val);
                        handleResponseFromJoiner(val);
                      }} 
                      onClose={() => setShowScanner(false)} 
                    />
                  </div>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    <textarea
                      placeholder="Paste the Base64 ANSWER code generated on your Tablet here to complete connection..."
                      value={remoteSignalInput}
                      onChange={(e) => {
                        setRemoteSignalInput(e.target.value);
                        if (e.target.value.trim().length > 100) {
                          handleResponseFromJoiner(e.target.value);
                        }
                      }}
                      className="w-full text-xs font-mono p-3 border border-stone-200 rounded-xl bg-stone-50 h-20 outline-none focus:border-indigo-500 focus:bg-white resize-none transition-all placeholder:text-stone-300"
                    />
                    <button
                      disabled={!remoteSignalInput.trim()}
                      onClick={() => handleResponseFromJoiner(remoteSignalInput)}
                      className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-750 disabled:bg-stone-200 disabled:text-stone-400 disabled:cursor-not-allowed text-white font-semibold text-xs rounded-xl shadow-md cursor-pointer transition-all flex items-center justify-center gap-2"
                    >
                      Establish P2P Direct Connection <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {connectionState === 'connecting' && (
            <div className="flex flex-col items-center justify-center py-12 text-center text-stone-500 gap-4">
              <RefreshCw className="w-10 h-10 text-indigo-500 animate-spin" />
              <span className="font-medium text-stone-800 text-sm">Negotiating direct WebRTC handshake...</span>
              <p className="text-xs text-stone-400 max-w-xs leading-relaxed">
                Confirming P2P security descriptors. This takes a microsecond.
              </p>
            </div>
          )}
        </div>
      )}

      {/* TABLET FLOW CONTROLS */}
      {deviceMode === 'tablet' && (
        <div className="w-full max-w-lg bg-white border border-stone-200 rounded-2xl shadow-lg p-6">
          <div className="flex items-center justify-between pb-4 border-b border-stone-100 mb-6">
            <span className="text-xs font-semibold text-teal-600 bg-teal-50 px-2.5 py-1 rounded-full uppercase tracking-wider">
              Step 1 of 2: Tablet Writer
            </span>
            <button 
              onClick={() => handleDeviceSelection('unselected')}
              className="text-xs text-stone-500 hover:text-stone-700 cursor-pointer underline decoration-dotted"
            >
              Reset Role
            </button>
          </div>

          {connectionState === 'idle' && (
            <div className="flex flex-col items-center">
              <h4 className="font-semibold text-stone-800 text-sm mb-1 text-center">Scan Laptop Viewport</h4>
              <p className="text-xs text-stone-400 text-center mb-5 max-w-xs leading-normal">
                To connect, click the button below to scan the QR code displayed on your Laptop screen.
              </p>

              <button
                onClick={() => setShowScanner(true)}
                className="w-full mb-4 py-3 bg-teal-600 hover:bg-teal-700 shadow-md flex items-center justify-center gap-2 text-white font-semibold text-sm rounded-xl cursor-pointer transition-all"
              >
                <Camera className="w-5 h-5 animate-pulse" />
                Scan Laptop Screen
              </button>

              {showScanner && (
                <div className="w-full mb-6">
                  <QRScanner 
                    onScan={handleOfferFromHost} 
                    onClose={() => setShowScanner(false)} 
                  />
                </div>
              )}

              <div className="w-full flex items-center gap-2 my-2 text-stone-300">
                <hr className="flex-1" />
                <span className="text-[10px] font-semibold uppercase tracking-widest text-stone-400">OR ENTER CODE</span>
                <hr className="flex-1" />
              </div>

              <textarea
                placeholder="Paste the manual Base64 OFFER code copied from your Laptop here..."
                value={remoteSignalInput}
                onChange={(e) => {
                  setRemoteSignalInput(e.target.value);
                  if (e.target.value.trim().length > 100) {
                    handleOfferFromHost(e.target.value);
                  }
                }}
                className="w-full text-xs font-mono p-3 border border-stone-200 rounded-xl bg-stone-50 h-20 outline-none focus:border-teal-500 focus:bg-white resize-none transition-all placeholder:text-stone-300"
              />
              <button
                disabled={!remoteSignalInput.trim()}
                onClick={() => handleOfferFromHost(remoteSignalInput)}
                className="w-full mt-3 py-2.5 bg-stone-800 disabled:bg-stone-200 disabled:text-stone-400 disabled:cursor-not-allowed hover:bg-stone-950 text-white font-semibold text-xs rounded-xl shadow transition-all cursor-pointer"
              >
                Apply Laptop Offer
              </button>
            </div>
          )}

          {connectionState === 'init-joiner' && (
            <div className="flex flex-col items-center justify-center py-10 gap-4 text-stone-500 text-sm">
              <RefreshCw className="w-8 h-8 text-teal-500 animate-spin" />
              <span>Analyzing Laptop SDP and building offline answers...</span>
            </div>
          )}

          {connectionState === 'joiner-answer' && (
            <div className="flex flex-col items-center">
              <h4 className="font-semibold text-stone-800 text-sm mb-1 text-center">Complete Laptop Connect</h4>
              <p className="text-xs text-stone-400 text-center mb-5 max-w-xs leading-normal">
                Hold your Tablet screen up for your Laptop camera to scan, or copy the connection text answer code to paste back into the laptop's input block.
              </p>

              {/* ANSWER DYNAMIC QR CODE */}
              {qrUrl ? (
                <div className="p-3 bg-white border-2 border-stone-100 rounded-xl shadow-inner mb-6">
                  <img 
                    src={qrUrl} 
                    alt="Joiner WebRTC Answer Code" 
                    className="w-52 h-52 block" 
                    referrerPolicy="no-referrer"
                  />
                </div>
              ) : (
                <div className="w-52 h-52 bg-stone-50 rounded-xl mb-6 border animate-pulse flex items-center justify-center text-xs text-stone-400">
                  Building code...
                </div>
              )}

              <button
                type="button"
                onClick={() => copyToClipboard(localSignal)}
                className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-stone-50 border border-stone-200 text-stone-700 hover:bg-stone-100 rounded-xl text-xs font-semibold transition-all cursor-pointer"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied Answer!' : 'Copy Answer String'}
              </button>
            </div>
          )}

          {connectionState === 'connecting' && (
            <div className="flex flex-col items-center justify-center py-12 text-center text-stone-500 gap-4">
              <RefreshCw className="w-10 h-10 text-teal-500 animate-spin" />
              <span className="font-medium text-stone-800 text-sm">Completing peer Handshake...</span>
            </div>
          )}
        </div>
      )}

      {/* OFFLINE DESK SPECIFICATION COMPASS */}
      <div className="flex items-center gap-5 mt-10 p-4 max-w-lg bg-stone-100/60 rounded-xl border border-stone-150 text-[11px] text-stone-500 leading-relaxed font-sans shadow-sm">
        <Compass className="w-8 h-8 text-indigo-500 shrink-0 select-none" />
        <div>
          <span className="font-semibold text-stone-700">Offline P2P Protocol Guide:</span> Once both devices are connected, the peer-to-peer lane operates purely on your local network/Wi-Fi router with zero data escaping on internet nodes. You can safely study completely disconnected from external WAN networks.
        </div>
      </div>

    </div>
  );
}

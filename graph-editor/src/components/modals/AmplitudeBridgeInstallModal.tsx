import React, { useEffect, useState } from 'react';
import { checkBridgeStatus, waitForExtension, getExtensionDownloadUrl, getExpectedVersion, type BridgeStatus } from '../../services/amplitudeBridgeService';
import './Modal.css';

interface AmplitudeBridgeInstallModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called when extension is detected (installed or already was). */
  onInstalled: (status: BridgeStatus) => void;
}

/**
 * Step-by-step modal guiding the user through installing the
 * DagNet Amplitude Bridge Chrome extension.
 *
 * Polls every 5s to detect when the extension appears.
 */
export function AmplitudeBridgeInstallModal({
  isOpen,
  onClose,
  onInstalled,
}: AmplitudeBridgeInstallModalProps) {
  const [polling, setPolling] = useState(false);
  const [detected, setDetected] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    setDetected(false);
    setPolling(true);

    const { promise, cancel } = waitForExtension(5000, 10 * 60 * 1000);

    promise
      .then((status) => {
        setDetected(true);
        setPolling(false);
        // Short delay so user sees the success message
        setTimeout(() => onInstalled(status), 800);
      })
      .catch(() => {
        setPolling(false);
      });

    return () => { cancel(); };
  }, [isOpen, onInstalled]);

  if (!isOpen) return null;

  const downloadUrl = getExtensionDownloadUrl();
  const version = getExpectedVersion();

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" style={{ maxWidth: '560px' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Install Amplitude Bridge</h2>
          <button className="modal-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {detected ? (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>&#10003;</div>
              <p style={{ fontSize: 14, fontWeight: 600, color: '#059669' }}>Extension detected!</p>
              <p style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Opening your funnel in Amplitude...</p>
            </div>
          ) : (
            <>
              <p style={{ fontSize: 13, color: '#374151', marginBottom: 16 }}>
                The Amplitude Bridge extension lets DagNet create funnel charts in your Amplitude workspace. One-time setup:
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Step number={1} title="Download the extension">
                  <a
                    href={downloadUrl}
                    download
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 12px',
                      background: '#4f46e5',
                      color: '#fff',
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: 500,
                      textDecoration: 'none',
                      marginTop: 4,
                    }}
                  >
                    Download v{version} (.zip)
                  </a>
                </Step>

                <Step number={2} title="Unzip the downloaded file">
                  <p style={{ fontSize: 12, color: '#6b7280' }}>
                    Extract the .zip to a folder on your computer (e.g. Desktop or Downloads).
                  </p>
                </Step>

                <Step number={3} title="Open Chrome extensions page">
                  <p style={{ fontSize: 12, color: '#6b7280' }}>
                    Type <code style={{ background: '#f3f4f6', padding: '2px 6px', borderRadius: 3, fontSize: 11 }}>chrome://extensions</code> in
                    your address bar and press Enter.
                  </p>
                </Step>

                <Step number={4} title="Enable Developer mode">
                  <p style={{ fontSize: 12, color: '#6b7280' }}>
                    Toggle the <strong>Developer mode</strong> switch in the top-right corner of the extensions page.
                  </p>
                </Step>

                <Step number={5} title="Load the extension">
                  <p style={{ fontSize: 12, color: '#6b7280' }}>
                    Click <strong>Load unpacked</strong>, then select the folder you extracted in step 2.
                  </p>
                </Step>
              </div>

              {polling && (
                <div style={{ marginTop: 20, textAlign: 'center', fontSize: 12, color: '#6b7280' }}>
                  <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite', marginRight: 6 }}>&#8635;</span>
                  Waiting for extension...
                </div>
              )}
            </>
          )}
        </div>

        {!detected && (
          <div className="modal-footer">
            <button className="modal-btn modal-btn-secondary" onClick={onClose}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <div style={{
        width: 24, height: 24, borderRadius: '50%',
        background: '#eef2ff', color: '#4338ca',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 12, fontWeight: 700, flexShrink: 0, marginTop: 1,
      }}>
        {number}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2937', marginBottom: 2 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

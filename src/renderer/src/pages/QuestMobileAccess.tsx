import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type {
  HermesMobileAccessStatus,
  HermesMobileLanConfigInput,
  HermesMobileRoute
} from '@shared/types';
import { IconAlert, IconPhone, IconRefresh } from '../components/icons';
import { IconX } from '../components/icons';

const DEFAULT_HERMES_LAN_PORT = 18_766;

function isLoopbackHost(value: string): boolean {
  return value === '127.0.0.1' || value === '::1';
}

export function preferredHermesLanQuickConfig(
  status: HermesMobileAccessStatus,
  addresses: readonly string[]
): HermesMobileLanConfigInput | null {
  const configured = status.configured;
  const configuredAddressIsLive = configured
    && (status.running || addresses.includes(configured.bindHost));
  if (configured && !isLoopbackHost(configured.bindHost) && configuredAddressIsLive) {
    return {
      bindHost: configured.bindHost,
      port: configured.port,
      publicHost: configured.publicHost,
      publicPort: configured.publicPort
    };
  }

  const address = addresses.find((candidate) => !isLoopbackHost(candidate));
  if (!address) return null;
  const port = configured?.port ?? DEFAULT_HERMES_LAN_PORT;
  return { bindHost: address, port, publicHost: address, publicPort: port };
}

function secondsRemaining(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1_000));
}

export function QuestMobileAccess({
  projectId,
  projectName,
  onRunningChange,
  onClose
}: {
  projectId: string;
  projectName: string;
  onRunningChange?: (running: boolean) => void;
  onClose?: () => void;
}) {
  const requestRef = useRef(0);
  const [status, setStatus] = useState<HermesMobileAccessStatus | null>(null);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [host, setHost] = useState('');
  const [port, setPort] = useState(DEFAULT_HERMES_LAN_PORT);
  const [pairing, setPairing] = useState<HermesMobileRoute | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const renderPairing = useCallback(async (offer: HermesMobileRoute) => {
    const image = await QRCode.toDataURL(offer.pairingUrl, {
      width: 236,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#111318', light: '#ffffff' }
    });
    setPairing(offer);
    setQrDataUrl(image);
    setNow(Date.now());
  }, []);

  const generatePairing = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await renderPairing(await window.aibox.createHermesMobilePairing(projectId));
      setStatus(await window.aibox.getHermesMobileAccessStatus(projectId));
    } catch (nextError) {
      setPairing(null);
      setQrDataUrl(null);
      setError(nextError instanceof Error ? nextError.message : '手机连接码生成失败');
    } finally {
      setBusy(false);
    }
  }, [projectId, renderPairing]);

  const prepare = useCallback(async () => {
    const requestId = ++requestRef.current;
    setBusy(true);
    setError(null);
    try {
      const [current, detectedAddresses] = await Promise.all([
        window.aibox.getHermesMobileAccessStatus(projectId),
        window.aibox.listHermesMobileLanAddresses()
      ]);
      if (requestId !== requestRef.current) return;
      setAddresses(detectedAddresses);
      const preferred = preferredHermesLanQuickConfig(current, detectedAddresses);
      if (preferred) {
        setHost(preferred.bindHost);
        setPort(preferred.port ?? DEFAULT_HERMES_LAN_PORT);
      }

      if (!current.running && !preferred) throw new Error('未发现可用于手机访问的局域网地址');
      const needsLanRebind = !current.configured
        || isLoopbackHost(current.configured.bindHost)
        || (!current.running && !detectedAddresses.includes(current.configured.bindHost));
      const offer = await window.aibox.createHermesMobilePairing(
        projectId,
        current.running && !needsLanRebind ? undefined : preferred ?? undefined
      );
      if (requestId !== requestRef.current) return;
      await renderPairing(offer);
      setStatus(await window.aibox.getHermesMobileAccessStatus(projectId));
    } catch (nextError) {
      if (requestId !== requestRef.current) return;
      setError(nextError instanceof Error ? nextError.message : 'Quest 手机访问启动失败');
    } finally {
      if (requestId === requestRef.current) setBusy(false);
    }
  }, [projectId, renderPairing]);

  useEffect(() => {
    void prepare();
    return () => { requestRef.current += 1; };
  }, [prepare]);

  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  useEffect(() => {
    onRunningChange?.(status?.running === true);
  }, [onRunningChange, status?.running]);

  const remaining = pairing ? secondsRemaining(pairing.expiresAt, now) : 0;
  const configuredInput = useMemo<HermesMobileLanConfigInput | null>(() => {
    const value = host.trim();
    if (!value || !Number.isInteger(port) || port < 1_024 || port > 65_535) return null;
    return { bindHost: value, port, publicHost: value, publicPort: port };
  }, [host, port]);

  const startManually = async () => {
    if (!configuredInput) return;
    setBusy(true);
    setError(null);
    try {
      await renderPairing(await window.aibox.createHermesMobilePairing(projectId, configuredInput));
      setStatus(await window.aibox.getHermesMobileAccessStatus(projectId));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Quest 手机访问启动失败');
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await window.aibox.stopHermesMobileAccess(projectId));
      setPairing(null);
      setQrDataUrl(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Quest 手机访问关闭失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="quest-mobile-access" aria-label="手机 Hermes 对话访问">
      <div className="quest-mobile-head">
        <div><strong>手机 Hermes 对话</strong><span>{projectName}</span></div>
        {onClose && <button type="button" onClick={onClose} title="关闭" aria-label="关闭手机 Hermes 对话"><IconX size={14} /></button>}
        <button type="button" disabled={busy} onClick={() => void prepare()} title="重新连接" aria-label="重新连接手机 Hermes 对话">
          <IconRefresh size={14} />
        </button>
      </div>

      <div className="quest-mobile-scroll" aria-busy={busy}>
        <div className="quest-mobile-status" data-running={status?.running === true}>
          <IconPhone size={16} />
          <span><strong>{status?.running ? 'Hermes 对话已共享' : busy ? '正在准备' : '尚未共享'}</strong><small>{status?.activeRoutes[0]?.origin ?? '当前项目 Hermes 服务'}</small></span>
          <i />
        </div>

        {error && <div className="quest-mobile-error"><IconAlert size={13} />{error}</div>}

        {pairing && qrDataUrl && remaining > 0 && (
          <section className="quest-mobile-pairing">
            <img src={qrDataUrl} alt="手机 Hermes 对话二维码" />
            <div className="quest-mobile-code"><span>一次性验证码</span><strong>{pairing.code}</strong><small>{remaining} 秒</small></div>
            <div className="quest-mobile-url">{pairing.pairingUrl}</div>
          </section>
        )}

        {pairing && remaining === 0 && (
          <div className="quest-mobile-expired"><span>连接码已过期</span><button className="btn small" type="button" disabled={busy} onClick={() => void generatePairing()}>重新生成</button></div>
        )}

        <section className="quest-mobile-controls">
          <label><span>局域网地址</span><input list="quest-lan-addresses" value={host} disabled={busy || status?.running} onChange={(event) => setHost(event.target.value)} /></label>
          <datalist id="quest-lan-addresses">{addresses.map((address) => <option key={address} value={address} />)}</datalist>
          <label><span>端口</span><input type="number" min={1024} max={65535} value={port} disabled={busy || status?.running} onChange={(event) => setPort(Number(event.target.value))} /></label>
          <div className="quest-mobile-actions">
            {status?.running
              ? <><button className="btn small" type="button" disabled={busy} onClick={() => void generatePairing()}>刷新二维码</button><button className="btn small danger" type="button" disabled={busy} onClick={() => void stop()}>关闭访问</button></>
              : <button className="btn small primary" type="button" disabled={busy || !configuredInput} onClick={() => void startManually()}>启动 Hermes 对话</button>}
          </div>
        </section>
      </div>
    </aside>
  );
}

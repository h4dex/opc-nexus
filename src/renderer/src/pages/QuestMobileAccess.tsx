import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type {
  DshLanGatewayCompositionStatusView,
  DshLanGatewayConfigInput,
  DshLanPairingOfferView,
  DshLanRoleView
} from '@shared/types';
import { IconAlert, IconPhone, IconRefresh } from '../components/icons';

const DEFAULT_DSH_LAN_PORT = 18_766;

function isLoopbackHost(value: string): boolean {
  return value === '127.0.0.1' || value === '::1';
}

export function preferredDshLanQuickConfig(
  status: DshLanGatewayCompositionStatusView,
  addresses: readonly string[]
): DshLanGatewayConfigInput | null {
  const configured = status.configured;
  if (configured && !isLoopbackHost(configured.bindHost)) {
    return {
      bindHost: configured.bindHost,
      port: configured.port,
      publicHost: configured.publicHost,
      publicPort: configured.publicPort
    };
  }

  const address = addresses.find((candidate) => !isLoopbackHost(candidate));
  if (!address) return null;
  const port = configured?.port ?? DEFAULT_DSH_LAN_PORT;
  return { bindHost: address, port, publicHost: address, publicPort: port };
}

function secondsRemaining(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1_000));
}

export function QuestMobileAccess({
  projectName,
  onRunningChange
}: {
  projectName: string;
  onRunningChange?: (running: boolean) => void;
}) {
  const requestRef = useRef(0);
  const [status, setStatus] = useState<DshLanGatewayCompositionStatusView | null>(null);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [host, setHost] = useState('');
  const [port, setPort] = useState(DEFAULT_DSH_LAN_PORT);
  const [role, setRole] = useState<DshLanRoleView>('operator');
  const [pairing, setPairing] = useState<DshLanPairingOfferView | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const renderPairing = useCallback(async (offer: DshLanPairingOfferView) => {
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

  const generatePairing = useCallback(async (nextRole: DshLanRoleView = role) => {
    setBusy(true);
    setError(null);
    try {
      await renderPairing(await window.aibox.createDshLanPairing(nextRole));
    } catch (nextError) {
      setPairing(null);
      setQrDataUrl(null);
      setError(nextError instanceof Error ? nextError.message : '手机连接码生成失败');
    } finally {
      setBusy(false);
    }
  }, [renderPairing, role]);

  const prepare = useCallback(async () => {
    const requestId = ++requestRef.current;
    setBusy(true);
    setError(null);
    try {
      const [current, detectedAddresses] = await Promise.all([
        window.aibox.getDshLanGatewayStatus(),
        window.aibox.listMobileLanAddresses()
      ]);
      if (requestId !== requestRef.current) return;
      setAddresses(detectedAddresses);
      const preferred = preferredDshLanQuickConfig(current, detectedAddresses);
      if (preferred) {
        setHost(preferred.bindHost);
        setPort(preferred.port ?? DEFAULT_DSH_LAN_PORT);
      }

      const active = current.gateway.running
        ? current
        : preferred
          ? await window.aibox.startDshLanGateway(preferred)
          : current;
      if (requestId !== requestRef.current) return;
      setStatus(active);
      if (!active.gateway.running) {
        throw new Error(active.lastError ?? '未发现可用于手机访问的局域网地址');
      }
      await renderPairing(await window.aibox.createDshLanPairing('operator'));
    } catch (nextError) {
      if (requestId !== requestRef.current) return;
      setError(nextError instanceof Error ? nextError.message : 'Quest 手机访问启动失败');
    } finally {
      if (requestId === requestRef.current) setBusy(false);
    }
  }, [renderPairing]);

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
    onRunningChange?.(status?.gateway.running === true);
  }, [onRunningChange, status?.gateway.running]);

  const remaining = pairing ? secondsRemaining(pairing.expiresAt, now) : 0;
  const configuredInput = useMemo<DshLanGatewayConfigInput | null>(() => {
    const value = host.trim();
    if (!value || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return { bindHost: value, port, publicHost: value, publicPort: port };
  }, [host, port]);

  const startManually = async () => {
    if (!configuredInput) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.aibox.startDshLanGateway(configuredInput);
      setStatus(next);
      if (!next.gateway.running) throw new Error(next.lastError ?? 'DSH LAN Gateway 尚未就绪');
      await renderPairing(await window.aibox.createDshLanPairing(role));
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
      setStatus(await window.aibox.emergencyStopDshLanGateway());
      setPairing(null);
      setQrDataUrl(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Quest 手机访问关闭失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="quest-mobile-access" aria-label="Quest 手机 Web 访问">
      <div className="quest-mobile-head">
        <div><strong>手机 Web</strong><span>{projectName}</span></div>
        <button type="button" disabled={busy} onClick={() => void prepare()} title="重新连接" aria-label="重新连接手机 Web">
          <IconRefresh size={14} />
        </button>
      </div>

      <div className="quest-mobile-scroll" aria-busy={busy}>
        <div className="quest-mobile-status" data-running={status?.gateway.running === true}>
          <IconPhone size={16} />
          <span><strong>{status?.gateway.running ? '局域网已共享' : busy ? '正在准备' : '尚未共享'}</strong><small>{status?.gateway.origin ?? 'DSH / Cordis'}</small></span>
          <i />
        </div>

        {error && <div className="quest-mobile-error"><IconAlert size={13} />{error}</div>}

        {pairing && qrDataUrl && remaining > 0 && (
          <section className="quest-mobile-pairing">
            <img src={qrDataUrl} alt="Quest 手机 Web 二维码" />
            <div className="quest-mobile-code"><span>一次性验证码</span><strong>{pairing.code}</strong><small>{remaining} 秒</small></div>
            <div className="quest-mobile-url">{pairing.pairingUrl}</div>
          </section>
        )}

        {pairing && remaining === 0 && (
          <div className="quest-mobile-expired"><span>连接码已过期</span><button className="btn small" type="button" disabled={busy} onClick={() => void generatePairing()}>重新生成</button></div>
        )}

        <section className="quest-mobile-controls">
          <label><span>权限</span><select value={role} disabled={busy} onChange={(event) => {
            const nextRole = event.target.value as DshLanRoleView;
            setRole(nextRole);
            if (status?.gateway.running) void generatePairing(nextRole);
          }}><option value="operator">可操作</option><option value="viewer">只读</option></select></label>
          <label><span>局域网地址</span><input list="quest-lan-addresses" value={host} disabled={busy || status?.gateway.running} onChange={(event) => setHost(event.target.value)} /></label>
          <datalist id="quest-lan-addresses">{addresses.map((address) => <option key={address} value={address} />)}</datalist>
          <label><span>端口</span><input type="number" min={1} max={65535} value={port} disabled={busy || status?.gateway.running} onChange={(event) => setPort(Number(event.target.value))} /></label>
          <div className="quest-mobile-actions">
            {status?.gateway.running
              ? <><button className="btn small" type="button" disabled={busy} onClick={() => void generatePairing()}>刷新二维码</button><button className="btn small danger" type="button" disabled={busy} onClick={() => void stop()}>关闭访问</button></>
              : <button className="btn small primary" type="button" disabled={busy || !configuredInput} onClick={() => void startManually()}>启动手机访问</button>}
          </div>
        </section>
      </div>
    </aside>
  );
}

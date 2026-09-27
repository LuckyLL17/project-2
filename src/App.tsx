import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Html, Line, OrbitControls, Sky, Text } from '@react-three/drei';
import * as THREE from 'three';

type Status = '进行中' | '已救援' | '失败' | '暂停';
type Snapshot = { x: number; y: number; z: number; stamina: number; temperature: number; rope: number; anchors: number; rescued: boolean; elapsed: number; status: Status; message: string };
type Command = 'anchor' | 'rescue' | 'tighten' | 'restart' | 'pause' | null;

type ReplayEventType = 'move' | 'sprint' | 'anchor' | 'tighten' | 'pause' | 'success' | 'fail';
type ReplayEvent = { t: number; type: ReplayEventType };
type ReplayFrame = Snapshot & { heading: number; anchorPoints: [number, number, number][] };
type Replay = { frames: ReplayFrame[]; events: ReplayEvent[]; duration: number; result: '已救援' | '失败' };
type Recorder = { addFrame: (frame: ReplayFrame) => void; addEvent: (type: ReplayEventType, t: number) => void; finish: (result: '已救援' | '失败') => void };
type ReplayView = { x: number; y: number; z: number; heading: number; stamina: number; temperature: number; rope: number; anchors: number; anchorPoints: [number, number, number][]; rescued: boolean; elapsed: number; status: Status; message: string };

const VICTIM = new THREE.Vector3(5.2, 1.2, -4.8);
const START = new THREE.Vector3(-5.2, 1.05, 5.4);
const INITIAL_MESSAGE = '沿雪坡前进，找到受困者并建立安全锚点。';

const EVENT_META: Record<ReplayEventType, { label: string; icon: string }> = {
  move: { label: '移动', icon: '●' },
  sprint: { label: '冲刺', icon: '●' },
  anchor: { label: '建立锚点', icon: '◆' },
  tighten: { label: '收紧绳索', icon: '◆' },
  pause: { label: '暂停', icon: '◆' },
  success: { label: '救援成功', icon: '★' },
  fail: { label: '任务失败', icon: '★' },
};
const EVENT_ORDER: ReplayEventType[] = ['move', 'sprint', 'anchor', 'tighten', 'pause', 'success', 'fail'];

function lerpAngle(a: number, b: number, t: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function sampleReplay(replay: Replay, time: number): ReplayView {
  const frames = replay.frames;
  const t = THREE.MathUtils.clamp(time, 0, replay.duration);
  let hi = 0;
  while (hi < frames.length - 1 && frames[hi + 1].elapsed <= t) hi++;
  const a = frames[hi];
  const b = frames[Math.min(hi + 1, frames.length - 1)];
  const span = b.elapsed - a.elapsed;
  const k = span > 0 ? THREE.MathUtils.clamp((t - a.elapsed) / span, 0, 1) : 0;
  const mix = (x: number, y: number) => x + (y - x) * k;
  return {
    x: mix(a.x, b.x), y: mix(a.y, b.y), z: mix(a.z, b.z),
    heading: lerpAngle(a.heading, b.heading, k),
    stamina: mix(a.stamina, b.stamina), temperature: mix(a.temperature, b.temperature), rope: mix(a.rope, b.rope),
    anchors: a.anchors, anchorPoints: a.anchorPoints,
    rescued: a.rescued, elapsed: t, status: a.status, message: a.message,
  };
}

function formatClock(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}

function useKeys() {
  const keys = useRef<Record<string, boolean>>({});
  useEffect(() => {
    const down = (event: KeyboardEvent) => { keys.current[event.key.toLowerCase()] = true; if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(event.key.toLowerCase())) event.preventDefault(); };
    const up = (event: KeyboardEvent) => { keys.current[event.key.toLowerCase()] = false; };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);
  return keys;
}

function SnowGround() {
  const rocks = useMemo(() => [
    [-5, .35, 1.4, .55], [-2.3, .3, -2, .42], [0.8, .35, 2.7, .6], [3, .28, -1.2, .42], [6, .4, 2.2, .7], [7, .3, -5.6, .5], [-7, .32, -4.2, .58]
  ], []);
  return <group>
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow><planeGeometry args={[25, 22, 32, 32]} /><meshStandardMaterial color="#c8d9e0" roughness={.95} /></mesh>
    <mesh position={[0, -.18, 0]} receiveShadow><boxGeometry args={[24, .3, 21]} /><meshStandardMaterial color="#a8c4cf" /></mesh>
    {rocks.map(([x, scale, z, radius], index) => <mesh key={index} position={[x, radius * .55, z]} scale={[1.2, .75, .9]} castShadow><dodecahedronGeometry args={[radius, 1]} /><meshStandardMaterial color={index % 2 ? '#e7f2f4' : '#b6cfd8'} roughness={1} /></mesh>)}
    <mesh position={[0, .04, -1.5]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[5.7, 6, 64]} /><meshBasicMaterial color="#e6f4f5" transparent opacity={.22} /></mesh>
  </group>;
}

function Mountain() {
  return <group>
    <mesh position={[-8, 2.3, -5]} rotation={[0, .35, -.1]} castShadow><coneGeometry args={[5.8, 7.8, 5]} /><meshStandardMaterial color="#6f8f9c" roughness={1} /></mesh>
    <mesh position={[9, 2.8, -3]} rotation={[0, -.5, .05]} castShadow><coneGeometry args={[6.2, 9, 5]} /><meshStandardMaterial color="#5e7e8d" roughness={1} /></mesh>
    <mesh position={[-8.1, 6, -5.1]} rotation={[0, .35, -.1]}><coneGeometry args={[1.5, 2.2, 5]} /><meshStandardMaterial color="#eff8f7" /></mesh>
    <mesh position={[9.1, 7, -3.1]} rotation={[0, -.5, .05]}><coneGeometry args={[1.7, 2.6, 5]} /><meshStandardMaterial color="#edf7f6" /></mesh>
  </group>;
}

function CableLine() {
  const points = useMemo(() => [new THREE.Vector3(-8, 8.3, 5), new THREE.Vector3(0, 10, 0), new THREE.Vector3(8, 9, -4)], []);
  return <Line points={points} color="#304b55" lineWidth={2.2} />;
}

function Tower({ position, height = 5 }: { position: [number, number, number]; height?: number }) {
  return <group position={position}>
    <mesh position={[0, height / 2, 0]} castShadow><cylinderGeometry args={[.1, .15, height, 6]} /><meshStandardMaterial color="#455f68" metalness={.6} roughness={.45} /></mesh>
    <mesh position={[0, height, 0]}><boxGeometry args={[1.8, .12, .35]} /><meshStandardMaterial color="#425d67" metalness={.7} /></mesh>
    {[-.7, .7].map(x => <mesh key={x} position={[x, height / 2, 0]} rotation={[0, 0, x < 0 ? -.18 : .18]}><cylinderGeometry args={[.045, .045, height, 6]} /><meshStandardMaterial color="#6f8991" /></mesh>)}
  </group>;
}

function CableCar() {
  return <group position={[-.4, 8.25, 1]}>
    <mesh position={[0, -.75, 0]}><boxGeometry args={[2.5, 1.35, 1.35]} /><meshStandardMaterial color="#d95b43" metalness={.2} roughness={.4} /></mesh>
    <mesh position={[0, -.35, 0]}><boxGeometry args={[2.15, .7, 1.05]} /><meshStandardMaterial color="#bde9ec" transparent opacity={.72} /></mesh>
    {[-.82, .82].map(x => <mesh key={x} position={[x, -1.45, 0]}><cylinderGeometry args={[.14, .14, .12, 12]} /><meshStandardMaterial color="#263c42" /></mesh>)}
    <Text position={[0, -1.62, 0]} fontSize={.22} color="#fff4de" anchorX="center">CABLE 07</Text>
  </group>;
}

function Player({ position, heading }: { position: THREE.Vector3; heading: number }) {
  return <group position={position} rotation={[0, heading, 0]}>
    <mesh position={[0, .52, 0]} castShadow><capsuleGeometry args={[.22, .62, 5, 10]} /><meshStandardMaterial color="#d56b45" /></mesh>
    <mesh position={[0, 1.18, 0]} castShadow><sphereGeometry args={[.27, 16, 12]} /><meshStandardMaterial color="#f0c29a" /></mesh>
    <mesh position={[0, 1.2, .02]}><sphereGeometry args={[.28, 16, 8]} /><meshStandardMaterial color="#27383d" /></mesh>
    <mesh position={[-.28, .65, .02]} rotation={[0, 0, -.65]}><boxGeometry args={[.06, .65, .08]} /><meshStandardMaterial color="#2d5660" /></mesh>
    <mesh position={[.28, .65, .02]} rotation={[0, 0, .65]}><boxGeometry args={[.06, .65, .08]} /><meshStandardMaterial color="#2d5660" /></mesh>
    <Html position={[0, 1.65, 0]} center distanceFactor={9}><span className="player-tag">救援员</span></Html>
  </group>;
}

function Victim({ rescued }: { rescued: boolean }) {
  return <group position={VICTIM} rotation={[0, -.5, 0]}>
    {!rescued && <><mesh position={[0, .35, 0]} rotation={[0, 0, .2]} castShadow><capsuleGeometry args={[.22, .75, 5, 10]} /><meshStandardMaterial color="#f0a54e" /></mesh><mesh position={[0, .82, 0]}><sphereGeometry args={[.25, 14, 10]} /><meshStandardMaterial color="#e0b18a" /></mesh><Html position={[0, 1.4, 0]} center><span className="victim-tag">受困者 · 需要救援</span></Html></>}
    {rescued && <Html position={[0, .2, 0]} center><span className="rescued-tag">✓ 已固定</span></Html>}
  </group>;
}

function Anchors({ positions }: { positions: THREE.Vector3[] }) { return <>{positions.map((position, index) => <group key={`${position.x}-${position.z}-${index}`} position={position}><mesh position={[0, .25, 0]}><cylinderGeometry args={[.13, .18, .5, 8]} /><meshStandardMaterial color="#dfbd62" metalness={.5} /></mesh><Html position={[0, .65, 0]} center><span className="anchor-tag">锚点 {index + 1}</span></Html></group>)}</>; }

function GameScene({ commandRef, onSnapshot, recorder, mode, replayView }: { commandRef: React.MutableRefObject<Command>; onSnapshot: (snapshot: Snapshot) => void; recorder: Recorder; mode: 'live' | 'replay'; replayView: ReplayView | null }) {
  const keys = useKeys();
  const player = useRef(START.clone());
  const heading = useRef(0);
  const stamina = useRef(82);
  const temperature = useRef(74);
  const rope = useRef(10);
  const anchors = useRef<THREE.Vector3[]>([]);
  const rescued = useRef(false);
  const elapsed = useRef(0);
  const lastSnapshot = useRef(0);
  const status = useRef<Status>('进行中');
  const message = useRef(INITIAL_MESSAGE);
  const didInit = useRef(false);
  const wasMoving = useRef(false);
  const wasSprinting = useRef(false);
  const [renderPosition, setRenderPosition] = useState(START.clone());
  const [renderHeading, setRenderHeading] = useState(0);
  const [renderAnchors, setRenderAnchors] = useState<THREE.Vector3[]>([]);
  const [renderRescued, setRenderRescued] = useState(false);

  const syncRender = () => {
    setRenderPosition(player.current.clone());
    setRenderHeading(heading.current);
    setRenderAnchors(anchors.current.map(point => point.clone()));
    setRenderRescued(rescued.current);
  };

  // 退出回放时把场景渲染状态还原到任务实际状态，避免停留在回放游标处
  useEffect(() => { if (mode === 'live') syncRender(); }, [mode]);

  useFrame((_, delta) => {
    if (mode === 'replay') {
      if (!replayView) return;
      setRenderPosition(new THREE.Vector3(replayView.x, replayView.y, replayView.z));
      setRenderHeading(replayView.heading);
      setRenderAnchors(replayView.anchorPoints.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
      setRenderRescued(replayView.rescued);
      return;
    }
    const buildFrame = (): ReplayFrame => ({ x: player.current.x, y: player.current.y, z: player.current.z, heading: heading.current, stamina: stamina.current, temperature: temperature.current, rope: rope.current, anchors: anchors.current.length, anchorPoints: anchors.current.map(point => [point.x, point.y, point.z] as [number, number, number]), rescued: rescued.current, elapsed: elapsed.current, status: status.current, message: message.current });
    const emitFrame = () => { const frame = buildFrame(); recorder.addFrame(frame); onSnapshot(frame); };
    const resetSim = () => {
      player.current.copy(START); heading.current = 0; stamina.current = 82; temperature.current = 74; rope.current = 10;
      anchors.current = []; rescued.current = false; elapsed.current = 0; lastSnapshot.current = 0;
      status.current = '进行中'; message.current = '重新开始救援。';
      wasMoving.current = false; wasSprinting.current = false;
    };
    if (!didInit.current) { didInit.current = true; emitFrame(); }
    // 重新开始在任何状态下都生效；其余指令仅在任务进行中处理
    if (commandRef.current === 'restart') {
      commandRef.current = null;
      resetSim();
      emitFrame();
    } else if (status.current === '暂停') {
      if (commandRef.current === 'pause') { commandRef.current = null; status.current = '进行中'; message.current = '继续救援行动。'; onSnapshot(buildFrame()); }
      else if (commandRef.current) commandRef.current = null;
      return;
    } else if (status.current === '已救援' || status.current === '失败') {
      if (commandRef.current) commandRef.current = null;
      return;
    }
    elapsed.current += delta;
    const command = commandRef.current;
    if (command) {
      commandRef.current = null;
      if (command === 'pause') { status.current = '暂停'; message.current = '行动已暂停，再次点击继续。'; recorder.addEvent('pause', elapsed.current); emitFrame(); return; }
      if (command === 'anchor') {
        if (stamina.current > 12 && anchors.current.length < 3) { anchors.current = [...anchors.current, player.current.clone()]; stamina.current -= 8; rope.current = Math.max(4, rope.current - 2); message.current = '冰镐已打入雪壁，安全锚点建立。'; recorder.addEvent('anchor', elapsed.current); emitFrame(); } else message.current = '无法建立更多锚点：体力不足或锚点已达上限。';
      }
      if (command === 'tighten') { if (anchors.current.length) { rope.current = Math.max(2, rope.current - 1.5); message.current = '正在收紧救援绳索，下降路线更稳定。'; recorder.addEvent('tighten', elapsed.current); emitFrame(); } else message.current = '请先建立至少一个冰镐锚点。'; }
      if (command === 'rescue') { const distance = player.current.distanceTo(VICTIM); if (distance < 2.05 && anchors.current.length > 0 && !rescued.current) { rescued.current = true; status.current = '已救援'; message.current = '受困者已连接主绳，救援成功！'; recorder.addEvent('success', elapsed.current); emitFrame(); recorder.finish('已救援'); } else if (distance >= 2.05) message.current = `距离受困者还有 ${Math.max(0, distance - 2).toFixed(1)} m。`; else message.current = '需要先建立安全锚点再连接受困者。'; }
    }
    const input = new THREE.Vector3((keys.current.d || keys.current.arrowright ? 1 : 0) - (keys.current.a || keys.current.arrowleft ? 1 : 0), 0, (keys.current.s || keys.current.arrowdown ? 1 : 0) - (keys.current.w || keys.current.arrowup ? 1 : 0));
    const moving = input.lengthSq() > 0;
    const sprinting = moving && !!keys.current.shift && stamina.current > 1;
    if (moving && !wasMoving.current) recorder.addEvent('move', elapsed.current);
    if (sprinting && !wasSprinting.current) recorder.addEvent('sprint', elapsed.current);
    wasMoving.current = moving;
    wasSprinting.current = sprinting;
    if (moving) {
      input.normalize();
      const speed = sprinting ? 3.9 : 2.25;
      player.current.x = THREE.MathUtils.clamp(player.current.x + input.x * speed * delta, -10.2, 10.2);
      player.current.z = THREE.MathUtils.clamp(player.current.z + input.z * speed * delta, -8.2, 8.2);
      heading.current = Math.atan2(input.x, input.z);
      stamina.current = THREE.MathUtils.clamp(stamina.current + (sprinting ? -13 : -4) * delta, 0, 100);
      if (sprinting && stamina.current <= 1) message.current = '体力耗尽，停止冲刺。';
    } else stamina.current = THREE.MathUtils.clamp(stamina.current + 2.2 * delta, 0, 100);
    temperature.current = THREE.MathUtils.clamp(temperature.current - (moving ? .34 : .22) * delta, 0, 100);
    if (player.current.distanceTo(new THREE.Vector3(-5, 0, 5)) < 2.1) temperature.current = THREE.MathUtils.clamp(temperature.current + .3 * delta, 0, 100);
    if (temperature.current <= 0 || stamina.current <= 0) {
      status.current = '失败';
      message.current = temperature.current <= 0 ? '体温过低，救援行动失败。' : '体力耗尽，无法继续攀登。';
      recorder.addEvent('fail', elapsed.current);
      emitFrame();
      recorder.finish('失败');
      syncRender();
      return;
    }
    syncRender();
    if (elapsed.current - lastSnapshot.current > .12) { lastSnapshot.current = elapsed.current; emitFrame(); }
  });
  const ropePoints = [renderPosition.clone().add(new THREE.Vector3(0, .55, 0)), ...renderAnchors.map(point => point.clone().add(new THREE.Vector3(0, .3, 0))), VICTIM.clone().add(new THREE.Vector3(0, .3, 0))];
  return <><Sky distance={450} sunPosition={[-10, 8, -10]} inclination={.52} azimuth={.23} /><ambientLight intensity={1.1} /><directionalLight position={[-5, 10, 3]} intensity={2.5} castShadow shadow-mapSize={[1024, 1024]} /><hemisphereLight color="#d7f5ff" groundColor="#6d8a95" intensity={.8} /><Mountain /><SnowGround /><CableLine /><Tower position={[-8, 0, 5]} height={6.2} /><Tower position={[8, 0, -4]} height={6.8} /><CableCar /><Player position={renderPosition} heading={renderHeading} /><Victim rescued={renderRescued} /><Anchors positions={renderAnchors} />{ropePoints.length > 1 && <Line points={ropePoints} color={renderRescued ? '#f4d485' : '#d8e3df'} lineWidth={1.4} dashed={false} />}<OrbitControls enablePan={false} minDistance={10} maxDistance={25} maxPolarAngle={Math.PI / 2.05} target={[0, 1, 0]} /> </>;
}

function Meter({ label, value, color, suffix = '%' }: { label: string; value: number; color: string; suffix?: string }) { return <div className="meter"><div className="meter-head"><span>{label}</span><b>{Math.round(value)}{suffix}</b></div><div className="meter-track"><i style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color }} /></div></div>; }

function ReplayTimeline({ replay, time, onSeek }: { replay: Replay; time: number; onSeek: (t: number) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const seekFromClientX = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track || replay.duration <= 0) return;
    const rect = track.getBoundingClientRect();
    onSeek(THREE.MathUtils.clamp((clientX - rect.left) / rect.width, 0, 1) * replay.duration);
  }, [onSeek, replay.duration]);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromClientX(event.clientX);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => { if (event.buttons & 1) seekFromClientX(event.clientX); };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') { onSeek(Math.max(0, time - 2)); event.preventDefault(); }
    if (event.key === 'ArrowRight') { onSeek(Math.min(replay.duration, time + 2)); event.preventDefault(); }
    if (event.key === 'Home') { onSeek(0); event.preventDefault(); }
    if (event.key === 'End') { onSeek(replay.duration); event.preventDefault(); }
  };
  const progress = replay.duration > 0 ? Math.min(100, (time / replay.duration) * 100) : 0;
  return <div className="timeline" ref={trackRef} role="slider" aria-label="回放时间线" aria-valuemin={0} aria-valuemax={Math.round(replay.duration)} aria-valuenow={Math.round(time)} tabIndex={0} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onKeyDown={onKeyDown}>
    <div className="timeline-track" />
    <div className="timeline-fill" style={{ width: `${progress}%` }} />
    {replay.events.map((event, index) => <i key={index} className={`timeline-marker marker-${event.type}`} style={{ left: `${replay.duration > 0 ? (event.t / replay.duration) * 100 : 0}%` }} title={`${EVENT_META[event.type].label} · ${formatClock(event.t)}`} />)}
    <div className="timeline-handle" style={{ left: `${progress}%` }} />
  </div>;
}

export default function App() {
  const commandRef = useRef<Command>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>({ x: START.x, y: START.y, z: START.z, stamina: 82, temperature: 74, rope: 10, anchors: 0, rescued: false, elapsed: 0, status: '进行中', message: INITIAL_MESSAGE });
  const [replay, setReplay] = useState<Replay | null>(null);
  const [mode, setMode] = useState<'live' | 'replay'>('live');
  const [replayTime, setReplayTime] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const framesRef = useRef<ReplayFrame[]>([]);
  const eventsRef = useRef<ReplayEvent[]>([]);
  const replayTimeRef = useRef(0);
  replayTimeRef.current = replayTime;
  const statusRef = useRef(snapshot.status);
  statusRef.current = snapshot.status;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const recorder = useMemo<Recorder>(() => ({
    addFrame: frame => { framesRef.current.push(frame); },
    addEvent: (type, t) => { eventsRef.current.push({ type, t }); },
    finish: result => {
      const frames = framesRef.current;
      if (!frames.length) return;
      setReplay({ frames: [...frames], events: [...eventsRef.current], duration: frames[frames.length - 1].elapsed, result });
    },
  }), []);

  // 回放播放时钟：只推进回放游标，不触碰任务模拟
  useEffect(() => {
    if (!replayPlaying || mode !== 'replay' || !replay) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const next = Math.min(replay.duration, replayTimeRef.current + dt);
      setReplayTime(next);
      if (next >= replay.duration) { setReplayPlaying(false); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [replayPlaying, mode, replay]);

  // Esc 暂停 / 继续（回放模式下不干扰任务）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || modeRef.current !== 'live') return;
      if (statusRef.current === '进行中' || statusRef.current === '暂停') commandRef.current = 'pause';
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const restartMission = () => {
    framesRef.current = [];
    eventsRef.current = [];
    setReplay(null);
    setMode('live');
    setReplayPlaying(false);
    setReplayTime(0);
    commandRef.current = 'restart';
  };
  const exitReplay = () => { setMode('live'); setReplayPlaying(false); };
  const togglePlay = () => {
    if (!replay) return;
    if (mode !== 'replay') { setMode('replay'); setReplayTime(0); setReplayPlaying(true); return; }
    if (!replayPlaying && replayTime >= replay.duration) setReplayTime(0);
    setReplayPlaying(!replayPlaying);
  };
  const seekReplay = (t: number) => { if (!replay) return; setReplayTime(THREE.MathUtils.clamp(t, 0, replay.duration)); };

  const replayView = useMemo(() => (mode === 'replay' && replay ? sampleReplay(replay, replayTime) : null), [mode, replay, replayTime]);
  const view: Snapshot = replayView ?? snapshot;
  const replayEnded = !!replay && mode === 'replay' && !replayPlaying && replayTime >= replay.duration;
  const distance = Math.hypot(view.x - VICTIM.x, view.z - VICTIM.z);
  const issue = (command: Command) => { commandRef.current = command; };
  const usedEventTypes = EVENT_ORDER.filter(type => replay?.events.some(event => event.type === type));

  return <div className="game-shell"><header className="topbar"><div><span className="eyebrow">ALPINE RESCUE / MISSION 07</span><h1>雪山缆车救援行动</h1></div><div className="mission-status"><span className={view.status === '进行中' ? 'live-dot' : view.status === '暂停' ? 'pause-dot' : 'status-dot'} />{view.status}{mode === 'replay' && <span className="replay-chip">回放</span>}<span className="mission-time">{formatClock(view.elapsed)}</span></div></header><main className="game-layout"><section className="viewport-card"><div className="scene"><Canvas shadows camera={{ position: [11, 9, 13], fov: 42 }}><GameScene commandRef={commandRef} onSnapshot={setSnapshot} recorder={recorder} mode={mode} replayView={replayView} /></Canvas>{mode === 'replay' && <div className="replay-banner">回放模式 · 任务已冻结，场景与状态面板同步到选定时刻</div>}<div className="controls-hint"><span>WASD / 方向键 移动</span><span>Shift 冲刺</span><span>拖拽旋转视角</span></div><div className="crosshair">＋</div></div></section><aside className="hud"><section className="objective"><div className="section-kicker">当前任务 / RESCUE OBJECTIVE</div><h2>抵达受困者位置并完成绳索固定</h2><div className="objective-row"><span className={distance < 2.05 ? 'check done' : 'check'}>{distance < 2.05 ? '✓' : '○'}</span><span>接近受困者 <b>{distance.toFixed(1)} m</b></span></div><div className="objective-row"><span className={view.anchors > 0 ? 'check done' : 'check'}>{view.anchors > 0 ? '✓' : '○'}</span><span>建立安全锚点 <b>{view.anchors}/3</b></span></div><div className="objective-row"><span className={view.rescued ? 'check done' : 'check'}>{view.rescued ? '✓' : '○'}</span><span>连接主绳并救援</span></div></section><section className="vitals"><div className="section-kicker">救援员状态 / VITALS</div><Meter label="体力 STAMINA" value={view.stamina} color="#78d8a1" /><Meter label="体温 BODY TEMP" value={view.temperature} color={view.temperature < 30 ? '#ed7968' : '#75cfee'} /></section><section className="equipment"><div className="section-kicker">装备与绳索 / GEAR</div><div className="gear-row"><div className="gear-icon">⛏</div><div><b>冰镐锚点</b><small>用于固定救援路线</small></div><strong>{view.anchors}/3</strong></div><div className="gear-row"><div className="gear-icon rope-icon">⌁</div><div><b>救援绳</b><small>剩余可用长度</small></div><strong>{view.rope.toFixed(1)} m</strong></div></section><section className="actions"><div className="section-kicker">操作 / ACTIONS</div><div className="action-grid"><button onClick={() => issue('anchor')} disabled={mode !== 'live' || snapshot.status !== '进行中'}><span>Q</span>打入冰镐锚点</button><button onClick={() => issue('rescue')} disabled={mode !== 'live' || snapshot.status !== '进行中'}><span>E</span>连接受困者</button><button onClick={() => issue('tighten')} disabled={mode !== 'live' || snapshot.status !== '进行中'}><span>R</span>收紧救援绳</button><button onClick={() => issue('pause')} disabled={mode !== 'live' || (snapshot.status !== '进行中' && snapshot.status !== '暂停')}><span>Esc</span>{snapshot.status === '暂停' ? '继续行动' : '暂停行动'}</button></div></section><section className="replay"><div className="section-kicker">任务回放 / REPLAY</div>{!replay && <p className="replay-empty">暂无回放记录：完成任务（成功或失败）后可在此复盘全过程。</p>}{replay && <><div className="replay-head"><span className={`replay-result ${replay.result === '已救援' ? 'ok' : 'bad'}`}>{replay.result === '已救援' ? '✓ 救援成功' : '✕ 任务失败'}</span><span className="replay-duration">时长 {formatClock(replay.duration)}</span></div><ReplayTimeline replay={replay} time={replayTime} onSeek={seekReplay} /><div className="replay-readout"><span>{formatClock(replayTime)}</span><span>{formatClock(replay.duration)}</span></div>{usedEventTypes.length > 0 && <div className="replay-legend">{usedEventTypes.map(type => <span key={type}><i className={`timeline-marker marker-${type}`} />{EVENT_META[type].label}</span>)}</div>}<div className="replay-controls"><button className="replay-play" onClick={togglePlay}>{replayPlaying ? '⏸ 暂停' : replayEnded ? '↻ 重新播放' : '▶ 播放'}</button>{mode === 'replay' && <button className="replay-exit" onClick={exitReplay}>退出回放</button>}</div>{replayEnded && <p className={`replay-endnote ${replay.result === '已救援' ? 'ok' : 'bad'}`}>{replay.result === '已救援' ? '回放结束：救援成功。' : '回放结束：任务失败，可拖动时间线复盘关键节点。'}</p>}{mode === 'replay' && !replayEnded && <p className="replay-hint">拖动时间线可定位到任意时刻，场景与状态面板将同步更新。</p>}</>}</section><div className={`mission-message ${view.status === '失败' ? 'danger' : view.status === '已救援' ? 'success' : ''}`}><span>◈</span>{view.message}</div><button className="restart" onClick={restartMission}>重新开始任务</button></aside></main><footer className="footer"><span>风速 32 km/h · 体感 -18°C · 能见度 420 m</span><span>局部雪崩警报：中等</span></footer></div>;
}

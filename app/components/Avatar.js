import { initials } from '../lib/util';

export default function Avatar({ src, name, size = 44, radius = '50%' }) {
  const style = { width: size, height: size, borderRadius: radius, fontSize: size * 0.4 };
  return (
    <div className="avatar-img" style={style}>
      {src ? <img src={src} alt={name || 'avatar'} /> : <span>{initials(name)}</span>}
    </div>
  );
}

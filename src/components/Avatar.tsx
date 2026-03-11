const AVATAR_PALETTE = [
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#f97316', // orange
  '#22c55e', // green
  '#06b6d4', // cyan
  '#eab308', // yellow
  '#ef4444', // red
];

function getColor(name: string): string {
  const code = name.charCodeAt(0) || 0;
  return AVATAR_PALETTE[code % AVATAR_PALETTE.length];
}

interface AvatarProps {
  src?: string | null;
  name: string;
  size?: number;
  style?: React.CSSProperties;
}

export default function Avatar({ src, name, size = 40, style }: AvatarProps) {
  const letter = (name || '?').charAt(0).toUpperCase();

  if (src) {
    return (
      <img
        src={src}
        alt=""
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          objectFit: 'cover',
          flexShrink: 0,
          ...style,
        }}
      />
    );
  }

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: getColor(name),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.45,
        fontWeight: 700,
        color: '#fff',
        flexShrink: 0,
        userSelect: 'none',
        ...style,
      }}
    >
      {letter}
    </div>
  );
}

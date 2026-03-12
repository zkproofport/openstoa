const AVATAR_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#22c55e', '#06b6d4', '#eab308'];

interface TopicAvatarProps {
  name: string;
  image?: string | null;
  size?: number;
  onClick?: () => void;
}

export default function TopicAvatar({ name, image, size = 40, onClick }: TopicAvatarProps) {
  if (image) {
    return (
      <img
        src={image}
        alt=""
        onClick={onClick}
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          objectFit: 'cover',
          flexShrink: 0,
          cursor: onClick ? 'pointer' : undefined,
        }}
      />
    );
  }
  const colorIndex = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % AVATAR_COLORS.length;
  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: '50%',
      background: AVATAR_COLORS[colorIndex],
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: size * 0.45,
      fontWeight: 700,
      color: '#fff',
      flexShrink: 0,
    }}>
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

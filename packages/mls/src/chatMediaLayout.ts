/**
 * How big a picture is allowed to be in a chat bubble — ONE rule, both clients.
 *
 * The defect this exists for: a full-page screenshot rendered unusably. On the
 * web the bubble capped HEIGHT (`maxHeight: 380`) and let width follow the
 * intrinsic ratio, so a 1179x2556 screenshot came out 175px wide and nothing in
 * it was legible; the taller the source, the narrower the result, which is the
 * wrong way round. The mini-app capped both axes at a fixed 220x220 square,
 * which does bound the height but center-crops every ordinary landscape photo
 * to a square as the price.
 *
 * The rule here is neither. WIDTH is fixed by the caller's slot, and the
 * intrinsic ASPECT RATIO is clamped to a range. Inside the range the picture is
 * untouched — a 4:3 or 16:9 photo in either orientation renders exactly as
 * shot. Outside it the box takes the clamped ratio and the picture is CROPPED
 * to fill it, never letterboxed: a letterboxed tall image is the sliver again,
 * with bars.
 *
 * Precedent, from source rather than from memory — both Signal clients clamp
 * the ratio and crop:
 *
 *   - Signal iOS `CVMediaAlbumView.swift` clamps a single attachment's ratio to
 *     [0.35, 1/0.35] with the comment "Clamp the aspect ratio so that very
 *     thin/wide content is presented in a reasonable way", and renders with
 *     `.scaleAspectFill` — a crop.
 *   - Signal Android bounds the thumbnail to 150-240dp wide and 100-320dp tall
 *     (`dimens.xml`) and the view is `android:scaleType="centerCrop"`
 *     (`conversation_item_sent_thumbnail.xml`), which works out to a ratio
 *     clamp of [0.469, 2.4].
 *
 * Two other clients scale-to-fit instead, and both reproduce our own bug on an
 * extreme ratio: Telegram Desktop's `CountPhotoMediaSize` shrinks a photo until
 * its height fits the bubble width, and Element Web's `suggestedSize` fits a
 * portrait image into a 183x324 box. A 1:10 image is a hairline in both.
 *
 * Why OUR tall bound is far tighter than either Signal client's: the
 * requirement is comparative. The owner's complaint is that our web bubble
 * runs LONGER than KakaoTalk's for the same picture, and that KakaoTalk crops.
 * Signal iOS's 0.35 would leave a 1179x2556 phone screenshot uncropped and
 * 520px tall at our width — the exact case being complained about. See the
 * bound itself for the number, its one sourced anchor, and what it costs.
 */

/**
 * Tallest a picture may render: 3:4, a 4:3 photo held portrait.
 *
 * The number is the OWNER'S requirement, not a taste call. Their complaint was
 * comparative — the web renders a tall picture LONGER than KakaoTalk does, and
 * KakaoTalk crops ("카카오는 어느정도 자른다") — so the target is not "better
 * than before", it is "shorter". 1.333x the picture's own width is an
 * aggressive cap that meets that.
 *
 * The one sourced anchor for the number: Signal Android pairs
 * `media_bubble_max_width 240dp` with `media_bubble_max_height 320dp`
 * (`res/values/dimens.xml`), and 320/240 is exactly 4:3. So the tallest box
 * the most-conservative client we could read will ever draw is the same shape
 * as this bound. At our 240px slot the two are literally the same 240x320 box.
 *
 * WHAT THIS COSTS, stated because it contradicts an earlier instruction rather
 * than merely narrowing it: a 16:9 photo held PORTRAIT is 0.5625, below this
 * bound, so it is now cropped to its top 75% instead of rendering whole. The
 * brief asked for 4:3 and 16:9 to be untouched, and once the cap is 1.333x
 * width that is arithmetically impossible for the portrait half of 16:9 —
 * leaving it whole REQUIRES allowing 1.78x, which is the length being
 * complained about. Both cannot hold. This file resolves it toward the
 * complaint, keeps 4:3 whole in both orientations, and leans on the crop badge
 * and tap-through for the rest. Raising this back to `9 / 16` is a one-token
 * change if the owner would rather have the height.
 */
export const CHAT_MEDIA_MIN_ASPECT = 3 / 4;

/**
 * Widest a picture may render.
 *
 * Not the mirror of the tall bound. Wide is not the reported defect and is not
 * the same shape of problem — a width-driven box makes a wide picture SHORT,
 * which is legible, where it makes a tall one NARROW, which is not. So the wide
 * bound only has to stop a panorama becoming a hairline, and it sits between
 * the two Signal clients' (2.4 on Android, ~2.857 on iOS).
 */
export const CHAT_MEDIA_MAX_ASPECT = 2.5;

/**
 * Never render a picture narrower than this, even when its source is tinier.
 *
 * A 40px-wide image otherwise draws as a 40px box, which is below a comfortable
 * tap target and reads as a broken image rather than a small one. Signal makes
 * the same allowance in `CVMediaAlbumView` ("We don't want to blow up small
 * images unnecessarily", floored at 150).
 */
export const CHAT_MEDIA_MIN_WIDTH = 120;

/** Where the crop keeps the pixels when it cannot keep them all. */
export type ChatMediaAnchor = 'top' | 'center';

export interface ChatMediaBox {
  /** Rendered width in CSS px / dp. Never exceeds the caller's slot. */
  width: number;
  /** Rendered height in CSS px / dp. */
  height: number;
  /** True when the clamp bit, i.e. some of the picture is not on screen. */
  cropped: boolean;
  /** Which edge the surviving pixels are anchored to. */
  anchor: ChatMediaAnchor;
}

function isPositiveFinite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * The box a picture of `naturalWidth` x `naturalHeight` gets in a `slotWidth`
 * slot.
 *
 * Pure and total: every input, including the degenerate ones, returns a box
 * with finite positive integer sides whose ratio is inside the clamp. A caller
 * can size its container from this before the picture has painted, which is the
 * point — the bubble reserves its space instead of jumping when the image
 * decodes.
 *
 * `cropped` is the caller's cue to show a "there is more" affordance. A crop
 * that is not announced is indistinguishable from a picture that simply ends,
 * and a reader has no way to know they are looking at part of something.
 */
export function chatMediaBox(
  naturalWidth: number | null | undefined,
  naturalHeight: number | null | undefined,
  slotWidth: number,
): ChatMediaBox {
  /*
   * A slot has to be a real width before anything else means anything. This is
   * a caller bug rather than a data problem — an unmeasured container, a zero
   * from a hidden panel — so it falls back to the minimum rather than throwing
   * and blanking the conversation.
   */
  const slot = isPositiveFinite(slotWidth)
    ? Math.max(Math.round(slotWidth), CHAT_MEDIA_MIN_WIDTH)
    : CHAT_MEDIA_MIN_WIDTH;

  /*
   * Dimensions unknown — not yet measured, or a picture whose header lied.
   *
   * A SQUARE, not the tall cap. This box is what gets reserved while the bytes
   * are still being fetched and decrypted, and reserving the tallest legal box
   * would leave most conversations with a screenful of empty space that
   * collapses the moment a picture turns out to be an ordinary photo. A square
   * is wrong by the least, in both directions.
   */
  if (!isPositiveFinite(naturalWidth) || !isPositiveFinite(naturalHeight)) {
    return { width: slot, height: slot, cropped: false, anchor: 'center' };
  }

  const ratio = naturalWidth / naturalHeight;
  const clamped = Math.min(Math.max(ratio, CHAT_MEDIA_MIN_ASPECT), CHAT_MEDIA_MAX_ASPECT);

  /*
   * Don't enlarge a picture past its own resolution, but don't let it go under
   * the minimum either. Upscaling a thumbnail to fill the slot only makes a
   * bigger blurry thumbnail.
   */
  const width = Math.min(slot, Math.max(Math.round(naturalWidth), CHAT_MEDIA_MIN_WIDTH));

  /*
   * `max(1, …)` because a legal-but-absurd slot (120 wide) against the wide
   * bound rounds to 48, which is fine — but the guard costs nothing and a
   * zero-height box would be an invisible, untappable picture.
   */
  const height = Math.max(1, Math.round(width / clamped));

  return {
    /*
     * Compared with a tolerance, not with `!==`. `clamped` comes out of
     * `Math.min`/`Math.max` and is bit-identical to `ratio` whenever neither
     * bound bit, so exact comparison would work today — but it would also make
     * this flag hostage to a future refactor that rounds, and a silently-false
     * `cropped` means a crop with no indicator, which is the one outcome this
     * whole file exists to prevent.
     */
    cropped: Math.abs(clamped - ratio) > 1e-9,
    /*
     * TOP for a picture that was too tall, CENTER otherwise.
     *
     * The tall case is overwhelmingly a screenshot, and a screenshot is read
     * downward from its first line — center-cropping one throws away the
     * heading that says what it is. Signal centers both, which is right for
     * photographs and wrong for the case being fixed here. A wide picture has
     * no privileged edge, so it keeps the centre.
     */
    anchor: ratio < CHAT_MEDIA_MIN_ASPECT ? 'top' : 'center',
    width,
    height,
  };
}

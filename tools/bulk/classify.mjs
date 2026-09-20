// classify.mjs — what kind of page an inventory row describes, from its pixels
// alone. ONE definition, because the inventory report counts with it and the
// read report joins on it.
//   rendered   the commonest level is exact white and covers ≥ 60 % of the page
//   blank      rendered, and nothing on it darker than 128
//   scan       anything else with an image: paper that is not 255, or a photo
//   small      the largest image is under 600 px wide — a thumbnail or a logo
//   vector     no embedded image (out of scope: rendering would invent pixels)
//   error      the page could not be decoded
export const classOf = p => p.error ? 'error' : p.vector ? 'vector' : !p.img ? 'error' : p.img[0] < 600 ? 'small'
  : p.bg === 255 && p.white >= 0.6 ? (p.ink ? 'rendered' : 'blank') : 'scan';

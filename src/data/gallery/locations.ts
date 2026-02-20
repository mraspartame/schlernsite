export interface GalleryPhoto {
  filename: string;
  caption?: string;
  /** Optional separate thumbnail filename if you have pre-generated thumbs */
  thumb?: string;
}

export interface GalleryLocation {
  slug: string;
  name: string;
  region: string;
  description: string;
  /** [latitude, longitude] */
  coordinates: [number, number];
  /** Filename of the cover photo, relative to /gallery/{slug}/ */
  coverPhoto: string;
  photos: GalleryPhoto[];
}

/**
 * Add your photo locations here.
 * Photos live in /public/gallery/{slug}/{filename}
 *
 * The map marker will appear at the given coordinates.
 * Clicking it links to /gallery/{slug}/
 */
export const locations: GalleryLocation[] = [
  {
    slug: 'dolomites',
    name: 'Dolomites',
    region: 'Italy',
    description:
      'The dramatic limestone peaks and emerald valleys of the Italian Dolomites — a UNESCO World Heritage landscape.',
    coordinates: [46.41, 11.84],
    coverPhoto: 'cover.jpg',
    photos: [
      // Add your actual photo filenames here, e.g.:
      // { filename: 'tre-cime.jpg', caption: 'Tre Cime di Lavaredo at golden hour' },
      // { filename: 'val-di-funes.jpg', caption: 'Val di Funes church' },
    ],
  },
  // Add more locations following the same pattern:
  // {
  //   slug: 'iceland',
  //   name: 'Iceland',
  //   region: 'Iceland',
  //   description: 'Volcanoes, glaciers, and the northern lights.',
  //   coordinates: [64.9, -18.5],
  //   coverPhoto: 'cover.jpg',
  //   photos: [],
  // },
];

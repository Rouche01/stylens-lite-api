/**
 * Parses the binary header of standard image formats (JPEG, PNG, WebP)
 * directly from an ArrayBuffer to determine its pixel dimensions.
 * 
 * This runs in pure JavaScript, is edge-safe (no DOM or Node fs APIs),
 * and takes less than a microsecond since it does not decode image pixels.
 * 
 * @param imageBuffer Raw binary buffer of the image
 * @returns Object containing width and height in pixels
 * @throws Error if the image format is unsupported or unrecognized
 */
export async function getImageDimensions(imageBuffer: ArrayBufferLike): Promise<{ width: number; height: number }> {
	const view = new DataView(imageBuffer);

	// 1. Detect PNG
	if (view.byteLength >= 24 && view.getUint32(0) === 0x89504E47 && view.getUint32(4) === 0x0D0A1A0A) {
		// PNG stores width at byte 16 and height at byte 20 (both 32-bit big-endian uints)
		return {
			width: view.getUint32(16),
			height: view.getUint32(20),
		};
	}

	// 2. Detect JPEG
	if (view.byteLength >= 2 && view.getUint16(0) === 0xFFD8) {
		let width = 0;
		let height = 0;
		let offset = 2; // Skip SOI (FF D8)
		while (offset < view.byteLength) {
			const marker = view.getUint16(offset);
			offset += 2;

			// EOI (End of Image) or SOS (Start of Scan) - stop scanning
			if (marker === 0xFFD9 || marker === 0xFFDA) {
				break;
			}

			// Start of Frame markers containing the dimensions:
			// SOF0 - SOF3 (0xFFC0 - 0xFFC3) and SOF5 - SOF15 (0xFFC5 - 0xFFCF)
			if ((marker >= 0xFFC0 && marker <= 0xFFC3) || (marker >= 0xFFC5 && marker <= 0xFFCF)) {
				// SOF block structure: marker(2), length(2), precision(1), height(2), width(2)
				height = view.getUint16(offset + 3); // Big-endian uint16
				width = view.getUint16(offset + 5);  // Big-endian uint16
				break;
			}

			// Read block length and skip to next segment
			const length = view.getUint16(offset);
			offset += length;
		}

		if (width > 0 && height > 0) {
			const orientation = getExifOrientation(view);
			// Orientations 5, 6, 7, 8 represent 90 or 270 degree rotation, which swaps visual width & height
			if (orientation >= 5 && orientation <= 8) {
				return { width: height, height: width };
			}
			return { width, height };
		}
	}

	// 3. Detect WebP (handles Lossy, Lossless, and Extended WebP)
	if (view.byteLength >= 30 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) { // "RIFF" ... "WEBP"
		const type = view.getUint32(12);

		if (type === 0x56503820) { // "VP8 " (Lossy WebP)
			const width = view.getUint16(26, true) & 0x3FFF;
			const height = view.getUint16(28, true) & 0x3FFF;
			return { width, height };
		}

		if (type === 0x5650384C) { // "VP8L" (Lossless WebP)
			// Dimensions are packed in 28 bits starting at byte 21
			const b0 = view.getUint8(21);
			const b1 = view.getUint8(22);
			const b2 = view.getUint8(23);
			const b3 = view.getUint8(24);
			const width = 1 + (((b1 & 0x3F) << 8) | b0);
			const height = 1 + (((b3 & 0xF) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6));
			return { width, height };
		}

		if (type === 0x56503858) { // "VP8X" (Extended WebP)
			// Width is 24-bit at byte 24-26, Height is 24-bit at byte 27-29
			const width = 1 + (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16));
			const height = 1 + (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16));
			return { width, height };
		}
	}

	throw new Error('Unsupported or unrecognized image format.');
}

/**
 * Detects the MIME type of standard image formats (JPEG, PNG, WebP)
 * directly from an ArrayBuffer header.
 * 
 * @param imageBuffer Raw binary buffer of the image
 * @returns MIME type string (e.g. 'image/png', 'image/jpeg', 'image/webp')
 */
export function getImageMimeType(imageBuffer: ArrayBufferLike): string {
	const view = new DataView(imageBuffer);

	// 1. Detect PNG
	if (view.byteLength >= 8 && view.getUint32(0) === 0x89504E47 && view.getUint32(4) === 0x0D0A1A0A) {
		return 'image/png';
	}

	// 2. Detect JPEG
	if (view.byteLength >= 2 && view.getUint16(0) === 0xFFD8) {
		return 'image/jpeg';
	}

	// 3. Detect WebP
	if (view.byteLength >= 12 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
		return 'image/webp';
	}

	return 'image/jpeg'; // Fallback
}

/**
 * Parsers JPEG EXIF headers from a DataView buffer to determine the image's orientation.
 * 
 * Safe, zero-dependency, and high-performance.
 * @param view DataView of the image array buffer
 * @returns Numeric EXIF orientation tag value (1-8, defaults to 1 if not found/invalid)
 */
function getExifOrientation(view: DataView): number {
	if (view.byteLength < 2 || view.getUint16(0) !== 0xFFD8) {
		return 1; // Not a JPEG
	}

	let offset = 2;
	while (offset < view.byteLength) {
		const marker = view.getUint16(offset);
		offset += 2;

		if (marker === 0xFFE1) {
			// Found APP1 (EXIF) segment
			const length = view.getUint16(offset);
			// Validate EXIF header (Exif\0\0)
			if (offset + 8 < view.byteLength && view.getUint32(offset + 2) === 0x45786966 && view.getUint16(offset + 6) === 0) {
				const tiffOffset = offset + 8;
				// Read byte order (II = Little Endian, MM = Big Endian)
				const isLittleEndian = view.getUint16(tiffOffset) === 0x4949;
				if (view.getUint16(tiffOffset + 2) !== 0x002A) {
					return 1; // Invalid TIFF magic number
				}

				const firstIFDOffset = view.getUint32(tiffOffset + 4, isLittleEndian);
				let ifdOffset = tiffOffset + firstIFDOffset;

				if (ifdOffset + 2 < view.byteLength) {
					const numEntries = view.getUint16(ifdOffset, isLittleEndian);
					let entryOffset = ifdOffset + 2;

					for (let i = 0; i < numEntries; i++) {
						if (entryOffset + 12 > view.byteLength) break;
						const tag = view.getUint16(entryOffset, isLittleEndian);
						if (tag === 0x0112) {
							// Tag 0x0112 is EXIF Orientation!
							return view.getUint16(entryOffset + 8, isLittleEndian);
						}
						entryOffset += 12;
					}
				}
			}
			offset += length;
		} else if ((marker & 0xFF00) === 0xFF00) {
			// Skip other JPEG markers
			if (marker === 0xFFD9 || marker === 0xFFDA) {
				break; // End of metadata header segment
			}
			const length = view.getUint16(offset);
			offset += length;
		} else {
			break;
		}
	}

	return 1; // Default
}


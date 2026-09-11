export async function orientImageJpeg(images: ImagesBinding, bytes: ArrayBuffer): Promise<ArrayBuffer> {
	const oriented = (
		await images.input(new Blob([bytes]).stream()).output({
			format: 'image/jpeg',
			quality: 90,
		})
	).response();

	if (!oriented.ok || !oriented.body) {
		throw new Error(`Failed to orient outfit image (${oriented.status})`);
	}

	return oriented.arrayBuffer();
}

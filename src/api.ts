export const uploadImage = async (
  base64: string | string[],
): Promise<string[]> => {
  const apiUrl = "https://img.scdn.io/api/v1.php";

  const uploadSingleImage = async (imageBase64: string): Promise<string> => {
    const singleFormData = new FormData();
    const blob = await (await fetch(imageBase64)).blob();
    singleFormData.append("image", blob, "image.jpg");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(apiUrl, {
      method: "POST",
      body: singleFormData,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return "";
    }

    const result = await response.json();
    return result.url || "";
  };

  if (Array.isArray(base64)) {
    const results: string[] = [];
    for (const item of base64) {
      const result = await uploadSingleImage(item);
      if (result) {
        results.push(result);
      }
    }
    return results;
  } else {
    return [await uploadSingleImage(base64)];
  }
};

import fs from "fs";
import { getAiChatConfigValue } from "../config/app";

const value = getAiChatConfigValue();

export const imageReview = async (filePathOrUrl: string) => {
  // console.log('进行审核的图片地址:', filePathOrUrl);

  try {
    const accessToken = await getAccessToken();
    const isUrl = /^https?:\/\//.test(filePathOrUrl);
    const isBase64 = !isUrl && /^[A-Za-z0-9+/=]+$/.test(filePathOrUrl);
    const imageBase64 =
      isUrl || isBase64 ? filePathOrUrl : getFileContentAsBase64(filePathOrUrl);
    const imgType = isUrl ? "0" : determineImageType(filePathOrUrl);
    const apiResponse = await callApi(accessToken, imageBase64, imgType, isUrl);
    console.log("审核请求结果:", apiResponse);

    return apiResponse;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
};

const getAccessToken = async (): Promise<string> => {
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: value.baidu.ak,
    client_secret: value.baidu.sk,
  });

  const response = await fetch(
    `https://aip.baidubce.com/oauth/2.0/token?${params.toString()}`,
    {
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error("Failed to fetch access token.");
  }

  const data = await response.json();
  return data.access_token;
};

const callApi = async (
  accessToken: string,
  imageBase64OrUrl: string,
  imgType: string,
  isUrl: boolean,
): Promise<any> => {
  const body = new URLSearchParams(
    isUrl
      ? { imgUrl: imageBase64OrUrl, imgType }
      : { image: imageBase64OrUrl, imgType },
  );

  const response = await fetch(
    `https://aip.baidubce.com/rest/2.0/solution/v1/img_censor/v2/user_defined?access_token=${accessToken}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
  );

  if (!response.ok) {
    throw new Error("Failed to call API.");
  }

  return await response.json();
};

const getFileContentAsBase64 = (path: string): string => {
  try {
    return fs.readFileSync(path, { encoding: "base64" });
  } catch (err) {
    throw new Error(`Failed to read file content as Base64. Details: ${err}`);
  }
};

const determineImageType = (filePath: string): string => {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ext === "gif" ? "1" : "0";
};

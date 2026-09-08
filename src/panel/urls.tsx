import React, { createContext, useContext } from "react";

// 每次渲染独立提供路径，避免独立服务和 AlemonX 并发访问时互相污染。
export const PanelBasePath = createContext("");

export const panelUrl = (basePath: string, url: string) =>
  url.startsWith("/") && !url.startsWith("//") ? `${basePath}${url}` : url;

export const PanelLink = ({ href, ...props }: React.ComponentProps<"a">) => {
  const basePath = useContext(PanelBasePath);
  return <a {...props} href={href ? panelUrl(basePath, href) : href} />;
};

export const PanelForm = ({
  action,
  ...props
}: React.ComponentProps<"form">) => {
  const basePath = useContext(PanelBasePath);
  return (
    <form
      {...props}
      action={typeof action === "string" ? panelUrl(basePath, action) : action}
    />
  );
};

export const PanelImage = ({ src, ...props }: React.ComponentProps<"img">) => {
  const basePath = useContext(PanelBasePath);
  return (
    <img
      {...props}
      src={typeof src === "string" ? panelUrl(basePath, src) : src}
    />
  );
};

type WindowBounds = {
	x: number;
	y: number;
	width: number;
	height: number;
};

type WindowSize = Pick<WindowBounds, "width" | "height">;

type JiraFetchRequest = {
	url: string;
	method?: string;
	headers?: HeadersInit;
	body?: string;
};

type JiraFetchResponse = {
	status: number;
	body: string;
};

type OpenExternalRequest = {
	url: string;
};

type AppRPCSchema = {
	bun: {
		requests: {
			windowMinimize: { params: undefined; response: void };
			windowMaximize: { params: undefined; response: void };
			windowClose: { params: undefined; response: void };
			windowSetFrame: { params: WindowBounds; response: void };
			windowSetSize: { params: WindowSize; response: void };
			windowGetFrame: { params: undefined; response: WindowBounds };
			jiraFetch: { params: JiraFetchRequest; response: JiraFetchResponse };
			openExternal: { params: OpenExternalRequest; response: void };
		};
		messages: Record<never, never>;
	};
	webview: {
		requests: Record<never, never>;
		messages: Record<never, never>;
	};
};

type BunRequestMap = AppRPCSchema["bun"]["requests"];
type BunRequestName = keyof BunRequestMap;
type BunRequestParams<M extends BunRequestName> = BunRequestMap[M]["params"];
type BunRequestResponse<M extends BunRequestName> = BunRequestMap[M]["response"];

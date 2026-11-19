export interface WebviewMessage {
	type: "grpc_request" | "grpc_request_cancel" | "trueforge_proxy" | "pacior_context_action" | "pacior_diff_action"
	grpc_request?: GrpcRequest
	grpc_request_cancel?: GrpcCancel
	trueforge_proxy?: {
		request_id: string
		url: string
		method?: string
		body?: string
	}
	pacior_context_action?: {
		action: "get_status" | "reindex" | "assemble"
		query?: string
		tokenBudget?: number
	}
	pacior_diff_action?: {
		action: "accept_all" | "reject_all" | "open_file" | "accept_file" | "reject_file"
		path?: string
	}
}

export type GrpcRequest = {
	service: string
	method: string
	message: any // JSON serialized protobuf message
	request_id: string // For correlating requests and responses
	is_streaming: boolean // Whether this is a streaming request
}

export type GrpcCancel = {
	request_id: string // ID of the request to cancel
}

export type ClineAskResponse = "yesButtonClicked" | "noButtonClicked" | "messageResponse"

export type ClineCheckpointRestore = "task" | "workspace" | "taskAndWorkspace"

export type TaskFeedbackType = "thumbs_up" | "thumbs_down"

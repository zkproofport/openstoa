/** Explicit per-method authorization. Adding an API requires a reviewed policy. */
export type ApiPolicy = {kind: 'public' | 'session' | 'owner'} | {kind: 'capability'; all?: readonly string[]; any?: readonly string[]};
export const API_AUTHORIZATION_POLICIES: Record<string, Record<string, ApiPolicy>> = {
  "/api/auth/challenge": {
    "POST": {
      "kind": "public"
    }
  },
  "/api/auth/cli-login/[loginId]": {
    "POST": {
      "kind": "public"
    }
  },
  "/api/auth/cli-login": {
    "POST": {
      "kind": "public"
    }
  },
  "/api/auth/dev-login": {
    "POST": {
      "kind": "public"
    }
  },
  "/api/auth/device/challenge": {
    "GET": {
      "kind": "owner"
    },
    "POST": {
      "kind": "owner"
    }
  },
  "/api/auth/logout": {
    "POST": {
      "kind": "session"
    }
  },
  "/api/auth/poll/[requestId]": {
    "GET": {
      "kind": "public"
    }
  },
  "/api/auth/proof-request": {
    "POST": {
      "kind": "public"
    }
  },
  "/api/auth/refresh": {
    "POST": {
      "kind": "session"
    }
  },
  "/api/auth/session": {
    "GET": {
      "kind": "session"
    }
  },
  "/api/auth/token-login": {
    "GET": {
      "kind": "public"
    }
  },
  "/api/auth/verify/ai": {
    "POST": {
      "kind": "public"
    }
  },
  "/api/health": {
    "GET": {
      "kind": "public"
    }
  },
  "/api/docs/openapi.json": {
    "GET": {
      "kind": "public"
    }
  },
  "/api/docs/proof-guide/[proofType]": {
    "GET": {
      "kind": "public"
    }
  },
  "/api/og": {
    "GET": {
      "kind": "public"
    }
  },
  "/api/og/image": {
    "GET": {
      "kind": "public"
    }
  },
  "/api/beta-signup": {
    "POST": {
      "kind": "public"
    }
  },
  "/api/account": {
    "DELETE": {
      "kind": "owner"
    }
  },
  "/api/keys/backup": {
    "GET": {
      "kind": "owner"
    },
    "POST": {
      "kind": "owner"
    },
    "DELETE": {
      "kind": "owner"
    }
  },
  "/api/keys/tak-backup": {
    "GET": {
      "kind": "owner"
    },
    "POST": {
      "kind": "owner"
    }
  },
  "/api/profile/api-keys": {
    "GET": {
      "kind": "owner"
    },
    "POST": {
      "kind": "owner"
    }
  },
  "/api/profile/api-keys/[keyId]": {
    "PATCH": {
      "kind": "owner"
    },
    "DELETE": {
      "kind": "owner"
    }
  },
  "/api/profile/ai-permissions": {
    "GET": {
      "kind": "owner"
    },
    "PUT": {
      "kind": "owner"
    }
  },
  "/api/test/clear-verification-cache": {
    "DELETE": {
      "kind": "owner"
    }
  },
  "/api/ask": {
    "POST": {
      "kind": "capability",
      "all": [
        "/ai/search"
      ]
    }
  },
  "/api/ask/stream": {
    "POST": {
      "kind": "capability",
      "all": [
        "/ai/search"
      ]
    }
  },
  "/api/bookmarks": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/post/read"
      ]
    }
  },
  "/api/feed": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/post/read"
      ]
    }
  },
  "/api/my/likes": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/post/read"
      ]
    }
  },
  "/api/my/posts": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/post/read"
      ]
    }
  },
  "/api/my/recorded": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/post/read"
      ]
    }
  },
  "/api/my/recorded-on-mine": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/post/read"
      ]
    }
  },
  "/api/recorded": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/post/read"
      ]
    }
  },
  "/api/categories": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/read"
      ]
    },
    "POST": {
      "kind": "owner"
    }
  },
  "/api/tags": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/read"
      ]
    }
  },
  "/api/stats": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/read"
      ]
    }
  },
  "/api/comments/[commentId]": {
    "DELETE": {
      "kind": "capability",
      "all": [
        "/openstoa/comment/delete"
      ]
    }
  },
  "/api/diag/e2ee": {
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/read"
      ]
    }
  },
  "/api/dm/candidates": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/read"
      ]
    }
  },
  "/api/dm": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/read"
      ]
    },
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/send"
      ]
    }
  },
  "/api/me/events": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/read"
      ]
    }
  },
  "/api/media/[...key]": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/media/read"
      ]
    }
  },
  "/api/posts/[postId]/bookmark": {
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/post/react"
      ]
    },
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/post/read"
      ]
    }
  },
  "/api/posts/[postId]/poll/vote": {
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/post/react"
      ]
    },
    "DELETE": {
      "kind": "capability",
      "all": [
        "/openstoa/post/react"
      ]
    }
  },
  "/api/posts/[postId]/reactions": {
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/post/react"
      ]
    },
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/post/read"
      ]
    }
  },
  "/api/posts/[postId]/vote": {
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/post/react"
      ]
    }
  },
  "/api/posts/[postId]/comments": {
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/comment/write"
      ]
    }
  },
  "/api/posts/[postId]/pin": {
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/post/write"
      ]
    }
  },
  "/api/posts/[postId]/record": {
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/post/record"
      ]
    }
  },
  "/api/posts/[postId]/record-status": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/post/read"
      ]
    }
  },
  "/api/posts/[postId]/records": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/post/read"
      ]
    }
  },
  "/api/posts/[postId]": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/post/read",
        "/openstoa/comment/read"
      ]
    },
    "PATCH": {
      "kind": "capability",
      "all": [
        "/openstoa/post/write"
      ]
    },
    "DELETE": {
      "kind": "capability",
      "all": [
        "/openstoa/post/delete"
      ]
    }
  },
  "/api/profile/badges": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/profile/read"
      ]
    },
    "PATCH": {
      "kind": "capability",
      "all": [
        "/openstoa/profile/edit"
      ]
    }
  },
  "/api/profile/domain-badge": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/profile/read"
      ]
    },
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/profile/edit"
      ]
    },
    "DELETE": {
      "kind": "capability",
      "all": [
        "/openstoa/profile/edit"
      ]
    }
  },
  "/api/profile/image": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/profile/read"
      ]
    },
    "PUT": {
      "kind": "capability",
      "all": [
        "/openstoa/profile/edit"
      ]
    },
    "DELETE": {
      "kind": "capability",
      "all": [
        "/openstoa/profile/edit"
      ]
    }
  },
  "/api/profile/nickname": {
    "PUT": {
      "kind": "capability",
      "all": [
        "/openstoa/profile/edit"
      ]
    }
  },
  "/api/push/preferences": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/notification/read"
      ]
    },
    "PATCH": {
      "kind": "capability",
      "all": [
        "/openstoa/notification/write"
      ]
    }
  },
  "/api/push/register": {
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/notification/write"
      ]
    },
    "DELETE": {
      "kind": "capability",
      "all": [
        "/openstoa/notification/write"
      ]
    }
  },
  "/api/topics/[topicId]/archive/root": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/read"
      ]
    },
    "PUT": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/manage-keys"
      ]
    }
  },
  "/api/topics/[topicId]/archive": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/read"
      ]
    },
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/send"
      ]
    }
  },
  "/api/topics/[topicId]/blind": {
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/edit"
      ]
    }
  },
  "/api/topics/[topicId]/chat/delivered": {
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/read"
      ]
    }
  },
  "/api/topics/[topicId]/chat/media": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/read"
      ]
    },
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/send"
      ]
    },
    "PATCH": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/send"
      ]
    },
    "DELETE": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/send"
      ]
    }
  },
  "/api/topics/[topicId]/chat/presence": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/read"
      ]
    }
  },
  "/api/topics/[topicId]/chat/read": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/read"
      ]
    },
    "PUT": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/read"
      ]
    }
  },
  "/api/topics/[topicId]/chat": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/read"
      ]
    },
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/send"
      ]
    }
  },
  "/api/topics/[topicId]/chat/subscribe": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/read"
      ]
    }
  },
  "/api/topics/[topicId]/invite": {
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/manage-members"
      ]
    }
  },
  "/api/topics/[topicId]/join": {
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/join"
      ]
    }
  },
  "/api/topics/[topicId]/keys/grant": {
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/manage-keys"
      ]
    }
  },
  "/api/topics/[topicId]/keys/request": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/read"
      ]
    },
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/read"
      ]
    }
  },
  "/api/topics/[topicId]/leave": {
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/leave"
      ]
    }
  },
  "/api/topics/[topicId]/members": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/read"
      ]
    },
    "PATCH": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/manage-members"
      ]
    },
    "DELETE": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/manage-members"
      ]
    }
  },
  "/api/topics/[topicId]/mls/commit": {
    "GET": {
      "kind": "capability",
      "any": [
        "/openstoa/chat/read",
        "/openstoa/chat/send"
      ]
    },
    "POST": {
      "kind": "capability",
      "any": [
        "/openstoa/chat/read",
        "/openstoa/chat/send"
      ]
    }
  },
  "/api/topics/[topicId]/mls/group-info": {
    "GET": {
      "kind": "capability",
      "any": [
        "/openstoa/chat/read",
        "/openstoa/chat/send"
      ]
    },
    "POST": {
      "kind": "capability",
      "any": [
        "/openstoa/chat/read",
        "/openstoa/chat/send"
      ]
    }
  },
  "/api/topics/[topicId]/mls/key-packages": {
    "GET": {
      "kind": "capability",
      "any": [
        "/openstoa/chat/read",
        "/openstoa/chat/send"
      ]
    },
    "POST": {
      "kind": "capability",
      "any": [
        "/openstoa/chat/read",
        "/openstoa/chat/send"
      ]
    }
  },
  "/api/topics/[topicId]/posts": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/post/read"
      ]
    },
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/post/write"
      ]
    }
  },
  "/api/topics/[topicId]/push": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/notification/read"
      ]
    },
    "PATCH": {
      "kind": "capability",
      "all": [
        "/openstoa/notification/write"
      ]
    }
  },
  "/api/topics/[topicId]/requests": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/manage-members"
      ]
    },
    "PATCH": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/manage-members"
      ]
    }
  },
  "/api/topics/[topicId]/tak/bundles": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/read"
      ]
    },
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/manage-keys"
      ]
    },
    "DELETE": {
      "kind": "capability",
      "all": [
        "/openstoa/chat/read"
      ]
    }
  },
  "/api/topics/[topicId]/tak/holder": {
    "GET": {
      "kind": "capability",
      "any": [
        "/openstoa/chat/read",
        "/openstoa/chat/send"
      ]
    },
    "POST": {
      "kind": "capability",
      "any": [
        "/openstoa/chat/read",
        "/openstoa/chat/send"
      ]
    },
    "PATCH": {
      "kind": "capability",
      "any": [
        "/openstoa/chat/read",
        "/openstoa/chat/send"
      ]
    },
    "DELETE": {
      "kind": "capability",
      "any": [
        "/openstoa/chat/read",
        "/openstoa/chat/send"
      ]
    }
  },
  "/api/topics/[topicId]/tak/root-fingerprint": {
    "GET": {
      "kind": "capability",
      "any": [
        "/openstoa/chat/read",
        "/openstoa/chat/send"
      ]
    },
    "PUT": {
      "kind": "capability",
      "any": [
        "/openstoa/chat/read",
        "/openstoa/chat/send"
      ]
    }
  },
  "/api/topics/[topicId]": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/read"
      ]
    },
    "PATCH": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/edit"
      ]
    },
    "DELETE": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/delete"
      ]
    }
  },
  "/api/topics/join/[inviteCode]": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/join"
      ]
    },
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/join"
      ]
    }
  },
  "/api/topics": {
    "GET": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/read"
      ]
    },
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/topic/create"
      ]
    }
  },
  "/api/upload": {
    "POST": {
      "kind": "capability",
      "all": [
        "/openstoa/upload/write"
      ]
    },
    "DELETE": {
      "kind": "capability",
      "all": [
        "/openstoa/upload/delete"
      ]
    }
  }
};

export function authorizationForRoute(routePath: string, method: string): ApiPolicy | undefined {
 if (!Object.hasOwn(API_AUTHORIZATION_POLICIES, routePath)) return undefined;
 const methods = API_AUTHORIZATION_POLICIES[routePath];
 return Object.hasOwn(methods, method) ? methods[method] : undefined;
}

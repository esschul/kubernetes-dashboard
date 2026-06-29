#!/usr/bin/env bash
set -euo pipefail

CONTEXT="cf-prod-noe-applications-aks-01"
NAMESPACE="checkout"

echo "Which deployment?"
echo "1) shopify-plugin"
echo "2) woo-plugin"
echo "3) checkout-api"
read -rp "Choice [1]: " choice
choice=${choice:-1}

case "$choice" in
    2) DEPLOYMENT="woo-plugin" ;;
    3) DEPLOYMENT="checkout-api" ;;
    *) DEPLOYMENT="shopify-plugin" ;;
esac

SELECTOR=$(kubectl --context "$CONTEXT" -n "$NAMESPACE" get deployment "$DEPLOYMENT" \
    -o jsonpath='{.spec.selector.matchLabels}' \
    | sed 's/[{}"]//g' | tr ',' '\n' | sed 's/:/=/' | tr '\n' ',' | sed 's/,$//')

CREATED=$(kubectl --context "$CONTEXT" -n "$NAMESPACE" get deployment "$DEPLOYMENT" \
    -o jsonpath='{.metadata.creationTimestamp}')

echo ""
echo "Deployment: $DEPLOYMENT (running since $CREATED)"
echo "Fetching all access logs..."
echo ""

kubectl --context "$CONTEXT" -n "$NAMESPACE" logs \
    --selector "$SELECTOR" \
    --since-time "$CREATED" \
    --prefix \
    --max-log-requests=20 \
    --timestamps \
    2>/dev/null \
| grep -v '"level"' \
| sed -n 's/.*"\([^"]*\)" "[^"]*" [0-9]*[[:space:]]*$/\1/p' \
| grep -v '^-$' \
| grep -v '^\s*$' \
| sort | uniq -c | sort -rn \
| awk 'BEGIN{total=0} {total+=$1; lines[NR]=$0; counts[NR]=$1} END{
    printf "%-8s %-7s %s\n", "Count", "%", "User-Agent"
    printf "%-8s %-7s %s\n", "-----", "---", "----------"
    for(i=1;i<=NR;i++){
        split(lines[i],a," ")
        ua=substr(lines[i], index(lines[i],a[2]))
        printf "%-8d %-7s %s\n", counts[i], sprintf("%.1f%%", (counts[i]/total)*100), ua
    }
    printf "\nTotal: %d requests\n", total
}' \
| head -40
